/**
 * 读 CC Switch 的 provider 表。
 *
 * ── 为什么这层要写防御 ──────────────────────────────────────
 *
 * CC Switch 没有公开的插件 API，我们依赖的是它的**私有 SQLite schema**：
 *
 *   providers(id, app_type, name, settings_config, is_current, sort_index, ...)
 *   settings_config 是一个 JSON 字符串，内部布局按 app_type 分叉：
 *
 *     codex   { auth: { OPENAI_API_KEY }, config: "<TOML 字符串>" }
 *               TOML 里 base_url = "https://..."、model = "..."
 *     claude  { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ... } }
 *
 * 这些都不是契约。上游改字段或改嵌套，这里必须**明确报错**而不是静默产出空
 * 分组——否则用户看到的是「同步成功但 omp 里什么都没变」，最难排查。
 *
 * 每个 app_type 一个解析器，解析失败返回带原因的对象。
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** 支持的 app_type；其余一律忽略（gemini / grokbuild / pi / claude-desktop）。 */
export const SUPPORTED_APPS = ["codex", "claude"];

/**
 * 从 TOML 字符串里取顶层键（只认 `key = "value"` 形式）。
 *
 * 不引第三方 TOML 解析器：这里只需要两个标量，且 codex 卡里的 TOML 是 CC Switch
 * 自己生成的、结构单一。真出问题会走 parse 失败分支报错，不会静默。
 */
function tomlString(cfg, key) {
	const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m");
	return (cfg.match(re) || [])[1] || "";
}

/** 从 key 取 4 位标识；不足时用卡 id 的哈希兜底。 */
export function tagOf(key, fallbackSeed) {
	const m = (String(key || "").replace(/^sk-/, "").match(/^[0-9a-fA-F]{4}/) || [])[0];
	if (m) return m.toLowerCase();
	// 非 sk- 开头的 key：退而求其次，用前缀的十六进制表示
	const raw = String(key || "");
	if (raw.length >= 4) return Buffer.from(raw.slice(0, 2)).toString("hex");
	return "";
}

/**
 * 解析 codex 面的卡。
 *
 * @returns {{ok: true, baseUrl: string, apiKey: string, pinned: string} | {ok: false, reason: string}}
 */
export function parseCodex(sc) {
	if (!sc || typeof sc !== "object") return { ok: false, reason: "settings_config 不是对象" };
	const apiKey = sc?.auth?.OPENAI_API_KEY ?? "";
	const cfg = typeof sc.config === "string" ? sc.config : "";
	if (!cfg) return { ok: false, reason: "缺少 config（TOML）字段" };
	const baseUrl = tomlString(cfg, "base_url");
	if (!baseUrl) return { ok: false, reason: "TOML 里没有 base_url" };
	if (!apiKey) return { ok: false, reason: "缺少 auth.OPENAI_API_KEY" };
	return { ok: true, baseUrl, apiKey, pinned: tomlString(cfg, "model") };
}

/**
 * 解析 claude 面的卡。
 *
 * @returns {{ok: true, baseUrl: string, apiKey: string, env: object} | {ok: false, reason: string}}
 */
export function parseClaude(sc) {
	if (!sc || typeof sc !== "object") return { ok: false, reason: "settings_config 不是对象" };
	const env = sc?.env;
	if (!env || typeof env !== "object") return { ok: false, reason: "缺少 env 字段" };
	const baseUrl = env.ANTHROPIC_BASE_URL ?? "";
	const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "";
	if (!baseUrl) return { ok: false, reason: "env 里没有 ANTHROPIC_BASE_URL" };
	if (!apiKey) return { ok: false, reason: "env 里没有 ANTHROPIC_AUTH_TOKEN" };
	return { ok: true, baseUrl, apiKey, env };
}

/** 表结构探测：确认 providers 表与关键列存在，并返回可用列名。 */
export function probeSchema(db) {
	let cols;
	try {
		cols = db.prepare("PRAGMA table_info(providers)").all();
	} catch (error) {
		return { ok: false, reason: `读不了 providers 表: ${error.message}`, columns: [] };
	}
	if (!cols.length) return { ok: false, reason: "providers 表不存在", columns: [] };
	const names = cols.map(c => c.name);
	const missing = ["id", "app_type", "name", "settings_config"].filter(x => !names.includes(x));
	if (missing.length) {
		return { ok: false, reason: `providers 表缺少列: ${missing.join(", ")}`, columns: names };
	}
	return { ok: true, columns: names };
}

/**
 * 读全部卡，按 app_type 分派解析器。
 *
 * @param {string} dbFile
 * @returns {{cards: object[], problems: object[], schema: object}}
 */
export function readCards(dbFile) {
	if (!dbFile || !existsSync(dbFile)) {
		throw new Error(`找不到 CC Switch 数据库：${dbFile || "(路径未配置)"}`);
	}
	const db = new DatabaseSync(dbFile, { readOnly: true });
	try {
		const schema = probeSchema(db);
		if (!schema.ok) {
			throw new Error(
				`数据库结构与预期不符 —— ${schema.reason}\n` +
					`这通常意味着 CC Switch 升级改了 schema。当前列：${schema.columns.join(", ") || "(无)"}`,
			);
		}

		const rows = db
			.prepare("SELECT id, name, app_type, is_current, settings_config FROM providers")
			.all();

		const cards = [];
		const problems = [];
		for (const r of rows) {
			if (!SUPPORTED_APPS.includes(r.app_type)) continue;

			let sc;
			try {
				sc = JSON.parse(r.settings_config || "{}");
			} catch {
				problems.push({ name: r.name, app: r.app_type, reason: "settings_config 不是合法 JSON" });
				continue;
			}

			const parsed = r.app_type === "codex" ? parseCodex(sc) : parseClaude(sc);
			if (!parsed.ok) {
				problems.push({ name: r.name, app: r.app_type, reason: parsed.reason });
				continue;
			}
			cards.push({
				id: r.id,
				name: r.name,
				app: r.app_type,
				isCurrent: !!r.is_current,
				...parsed,
			});
		}
		return { cards, problems, schema };
	} finally {
		db.close();
	}
}
