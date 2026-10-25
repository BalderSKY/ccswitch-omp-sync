/**
 * 配置解析：把「本机事实」与「代码逻辑」分开。
 *
 * 上一版把 host 白名单、固定名、Windows 路径全写死在源码里——那是为一台机器
 * 定制的脚本，不是能给别人用的工具。这里全部外置，优先级：
 *
 *   1. 命令行参数（--config path）
 *   2. 环境变量（CCSYNC_*）
 *   3. 配置文件（~/.config/ccswitch-omp-sync/config.json）
 *   4. 内置默认值
 *
 * 默认值只保留**跨机器通用**的部分（数据库常见位置、omp 配置常见位置），
 * 不包含任何特定中转站或固定 id。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

export const HOME = homedir();
export const IS_WIN = process.platform === "win32";

/** 默认配置文件位置（XDG）。 */
export const DEFAULT_CONFIG_FILE = join(HOME, ".config", "ccswitch-omp-sync", "config.json");

/** CC Switch 数据库的候选位置。 */
const DB_CANDIDATES = [
	// 原生安装在用户目录
	join(HOME, ".cc-switch", "cc-switch.db"),
	// WSL 访问 Windows 侧（路径由 CCSYNC_WIN_HOME 或自动探测决定）
];

/**
 * 是否处于「HOME 被隔离」的沙箱环境。
 *
 * `/tmp/x` 这类 HOME 与真实用户目录不一致时，视为测试沙箱。此时**禁止**任何
 * 跨 home 写入（包括探测 Windows 侧目录），否则「在沙箱里跑一遍」会写进真实
 * 配置 —— 实测踩过两次：一次写进 Windows 的 models.yml，一次写进生产 models.yml。
 *
 * 检测依据是 `os.userInfo().homedir`：它读 passwd，不受 `HOME` 环境变量影响，
 * 因此能识别出「HOME 被临时改了」。
 */
function isSandboxedHome() {
	try {
		const real = userInfo().homedir;
		return Boolean(real) && resolve(real) !== resolve(HOME);
	} catch {
		return false;
	}
}

/**
 * 探测 WSL 下的 Windows 用户目录。
 *
 * 不再硬编码 `/mnt/c/Users/<name>`：从 `USERPROFILE` 反推，或扫 `/mnt/c/Users`
 * 找一个含有 `.cc-switch` 的目录。都失败就返回空，交给上层报错。
 *
 * 沙箱环境下直接返回空 —— 见 isSandboxedHome 的注释。
 */
export function detectWinHome() {
	if (IS_WIN) return HOME;
	if (isSandboxedHome()) return "";
	const env = process.env.CCSYNC_WIN_HOME;
	if (env) return env;
	const profile = process.env.USERPROFILE;
	if (profile) {
		// C:\Users\foo → /mnt/c/Users/foo
		const m = /^([A-Za-z]):[\\/](.*)$/.exec(profile);
		if (m) {
			const guess = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
			if (existsSync(guess)) return guess;
		}
	}
	// 扫 /mnt/c/Users 下含 .cc-switch 的目录
	const root = "/mnt/c/Users";
	if (existsSync(root)) {
		try {
			for (const name of readdirSync(root)) {
				if (name === "Public" || name === "Default" || name === "All Users") continue;
				const dir = join(root, name);
				if (existsSync(join(dir, ".cc-switch", "cc-switch.db"))) return dir;
			}
		} catch {
			/* 读不了就当没有 */
		}
	}
	return "";
}

/** 读取 JSON 配置文件；不存在或损坏时返回空对象（不静默吞错，由调用方决定）。 */
export function readConfigFile(file) {
	if (!file || !existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`配置文件解析失败 ${file}: ${error.message}`);
	}
}

/**
 * 解析出运行时配置。
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] 显式指定的配置文件
 * @param {string[]} [opts.argv] 命令行参数（只用来取 --config）
 */
export function loadConfig(opts = {}) {
	const argv = opts.argv ?? process.argv.slice(2);
	const at = argv.indexOf("--config");
	const cliConfig = at >= 0 ? argv[at + 1] : "";
	const file = cliConfig || process.env.CCSYNC_CONFIG || DEFAULT_CONFIG_FILE;
	const fromFile = readConfigFile(file);

	const winHome = detectWinHome();

	/** 合并单值：环境变量 > 配置文件 > 默认。 */
	const pick = (envKey, fileKey, fallback) => process.env[envKey] ?? fromFile[fileKey] ?? fallback;

	/** 数据库路径：显式指定 > 本机 > Windows 侧。 */
	const dbFile =
		pick("CCSYNC_DB", "db", "") ||
		DB_CANDIDATES.find(p => existsSync(p)) ||
		(winHome ? join(winHome, ".cc-switch", "cc-switch.db") : "");

	/**
	 * 写入目标：默认 omp 的两处常见位置（主配置 + rp profile），
	 * 跨 Windows 侧默认关闭——**默认不外溢到另一个系统的配置文件**是安全默认。
	 */
	const ompTargets = pick("CCSYNC_TARGETS", "targets", null) ?? [
		join(HOME, ".omp", "agent", "models.yml"),
		join(HOME, ".omp", "profiles", "rp", "agent", "models.yml"),
	];

	const crossHome = pick("CCSYNC_CROSS_HOME", "crossHome", false);
	const winTargets =
		crossHome && winHome
			? [
					join(winHome, ".omp", "agent", "models.yml"),
					join(winHome, ".omp", "profiles", "rp", "agent", "models.yml"),
				]
			: [];

	const hosts = pick("CCSYNC_HOSTS", "hosts", null);
	if (hosts !== null && !Array.isArray(hosts)) {
		throw new Error("hosts 必须是数组，例如 [\"api.example.com\"]");
	}

	return {
		configFile: file,
		dbFile,
		winHome,
		targets: [...ompTargets, ...winTargets].filter((f, i, a) => existsSync(f) && a.indexOf(f) === i),

		/**
		 * codex 面卡的白名单。
		 *
		 * 只有这些 host 的卡会被导出——官方卡（OpenAI / DeepSeek 等）omp 自带
		 * provider，导进来只会重复。默认**空数组 = 全部导出**，让新用户先看到
		 * 效果，再按需收窄。
		 */
		hosts: hosts ?? [],

		/**
		 * 固定 id。
		 *
		 * key 前 4 位十六进制 → 固定 provider id。用于「omp 的 modelRoles 已经
		 * 引用了这个名字，不能让它变成哈希名」的场景。
		 */
		fixedIds: pick("CCSYNC_FIXED_IDS", "fixedIds", null) ?? {},

		/** claude 面：是否只导当前选中的那张（本地代理不认请求里的 key）。 */
		claudeCurrentOnly: pick("CCSYNC_CLAUDE_CURRENT_ONLY", "claudeCurrentOnly", true),

		/** claude 面的代理地址与占位 key。 */
		proxyBase: pick("CCSYNC_PROXY_BASE", "proxyBase", "http://127.0.0.1:15721"),
		proxyKey: pick("CCSYNC_PROXY_KEY", "proxyKey", "cc-switch-local"),

		/** 生成的 models[] 条目里的默认上下文窗口 / 最大输出。 */
		defaultContextWindow: pick("CCSYNC_CTX", "defaultContextWindow", 1_000_000),
		defaultMaxTokens: pick("CCSYNC_MAXT", "defaultMaxTokens", 128_000),

		/** 探针超时（毫秒）。 */
		probeTimeoutMs: pick("CCSYNC_PROBE_TIMEOUT", "probeTimeoutMs", 15_000),

		/** 过滤非对话模型的正则源串（可覆盖）。 */
		nonChatPattern:
			pick("CCSYNC_NON_CHAT", "nonChatPattern", null) ??
			"embedding|diffusion|(^|[-/])image|(^|[-/])dall-e",
	};
}

/** 供 CLI 报错时列出候选路径。 */
export function describeConfig(cfg) {
	return {
		配置文件: cfg.configFile,
		数据库: cfg.dbFile || "(未找到)",
		Windows用户目录: cfg.winHome || "(未探测到)",
		写入目标: cfg.targets.length ? cfg.targets : "(无可用文件)",
		白名单: cfg.hosts.length ? cfg.hosts.join(", ") : "(全部导出)",
	};
}
