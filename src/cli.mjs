#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * 设计原则：**失败要吵**。
 * 一个把配置写错、却打印「同步成功」的工具，比一个直接报错的工具难用十倍。
 * 所以每种「什么都没做」的情况都返回非零退出码并说明原因。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openCache } from "./cache.mjs";
import { readCards } from "./ccswitch.mjs";
import { describeConfig, loadConfig } from "./config.mjs";
import { applyToText, planGroups, readPrevModels } from "./sync.mjs";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const JSON_OUT = argv.includes("--json");
const SHOW_CONFIG = argv.includes("--print-config");
const REFRESH = argv.includes("--refresh");
const HELP = argv.includes("--help") || argv.includes("-h");

const USAGE = `
ccswitch-omp-sync — 把 CC Switch 的 provider 同步进 oh-my-pi / omp 的 models.yml

用法
  ccswitch-omp-sync                 # 写文件
  ccswitch-omp-sync --dry-run       # 只看会改什么
  ccswitch-omp-sync --json          # 机器可读输出
  ccswitch-omp-sync --print-config  # 打印解析后的配置（排查路径问题）

配置（优先级从高到低）
  --config <path>        显式指定配置文件
  CCSYNC_* 环境变量
  ~/.config/ccswitch-omp-sync/config.json

常用设置
  hosts             codex 面卡的白名单（host 名数组）。空 = 全部导出
  fixedIds          {"<key前4位>": "<固定 provider id>"}
  claudeCurrentOnly 只导 claude 面当前卡（默认 true）
  proxyBase         claude 面代理地址（默认 http://127.0.0.1:15721）
  crossHome         是否同时写 WSL 另一侧的 omp 配置（默认 false）
  nonChatPattern    过滤非对话模型的正则（默认 embedding|diffusion|image|dall-e）

退出码
  0  成功（或无需改动）
  1  配置/数据问题，未写入
  2  参数错误
`;

function main() {
	if (HELP) {
		process.stdout.write(USAGE);
		return 0;
	}

	let cfg;
	try {
		cfg = loadConfig({ argv });
	} catch (error) {
		console.error(`✗ 配置有问题：${error.message}`);
		return 2;
	}

	if (SHOW_CONFIG) {
		console.log(JSON.stringify(describeConfig(cfg), null, 2));
		return 0;
	}

	if (!cfg.dbFile) {
		console.error("✗ 找不到 CC Switch 数据库。");
		console.error("  常见位置：~/.cc-switch/cc-switch.db（WSL 下为 /mnt/c/Users/<你>/.cc-switch/cc-switch.db）");
		console.error("  可用 CCSYNC_DB=<路径> 或配置文件里的 db 指定。");
		return 1;
	}
	if (!cfg.targets.length) {
		console.error("✗ 没有可写的 models.yml。");
		console.error(`  找过：${join(process.env.HOME ?? "~", ".omp", "agent", "models.yml")} 等位置`);
		console.error("  可用 CCSYNC_TARGETS 或配置文件里的 targets 指定。");
		return 1;
	}

	let read;
	try {
		read = readCards(cfg.dbFile);
	} catch (error) {
		console.error(`✗ 读库失败：${error.message}`);
		return 1;
	}

	// 读现有模型列表用于抖动兜底
	const prevModels = readPrevModels(readFileSync(cfg.targets[0], "utf8"));

	/**
	 * 模型列表缓存。
	 *
	 * `--refresh` 时用纯内存缓存（等于不命中），强制重新探测全部卡。加卡或换 key
	 * 后缓存键本来就变了，会自动重探；`--refresh` 用于「上游上新了模型，想立刻
	 * 看到」的场景。
	 */
	const cache = openCache(REFRESH ? "" : cfg.cacheFile);

	const run = planGroups(read.cards, cfg, prevModels, { cache }).then(({ groups, skipped, liveKeys }) => {
		const problems = read.problems;
		if (!groups.length) {
			console.error("✗ 一个分组都产不出来，什么都不写。");
			for (const s of [...skipped, ...problems]) {
				console.error(`  ${String(s.name).slice(0, 24).padEnd(26)} ${s.reason}`);
			}
			return 1;
		}

		cache.prune(liveKeys ?? []);
		cache.flush();

		const results = [];
		for (const file of cfg.targets) {
			const raw = readFileSync(file, "utf8");
			const { text, changed, error } = applyToText(raw, groups, cfg);
			if (error) {
				results.push({ file, status: "skip", error });
				continue;
			}
			if (!changed) {
				results.push({ file, status: "same" });
				continue;
			}
			if (!DRY) writeFileSync(file, text);
			results.push({ file, status: DRY ? "would-write" : "written" });
		}

		if (JSON_OUT) {
			console.log(
				JSON.stringify(
					{
						groups: groups.map(g => ({ id: g.id, models: g.ids.length, url: g.f.baseUrl, note: g.note })),
						skipped: [...skipped, ...problems],
						files: results,
					},
					null,
					2,
				),
			);
		} else {
			for (const g of groups) {
				console.log(
					`  ${g.id.padEnd(16)} ${String(g.ids.length).padStart(3)} 模型  ${g.f.baseUrl}${g.note ? `  ⚠ ${g.note}` : ""}`,
				);
			}
			const allSkipped = [...skipped, ...problems];
			if (allSkipped.length) {
				console.log(`\n跳过 ${allSkipped.length} 项：`);
				for (const s of allSkipped) {
					console.log(`  ${String(s.name).slice(0, 24).padEnd(26)} ${s.reason}`);
				}
			}
			console.log();
			for (const r of results) {
				const label = { written: "✓ 已写", "would-write": "✓ 将改", same: "✓ 已一致", skip: "- 跳过" }[r.status];
				console.log(`${label}  ${r.file}${r.error ? `  (${r.error})` : ""}`);
			}
		}
		return 0;
	});

	return run;
}

const join = (...parts) => parts.join("/");

const code = await main();
process.exit(code);
