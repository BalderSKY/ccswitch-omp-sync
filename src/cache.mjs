/**
 * 模型列表缓存。
 *
 * ── 为什么必须有 ────────────────────────────────────────────
 *
 * 一轮同步里，联网探测 7 张卡要 **3.6 秒**，而渲染+写文件只要 **30 毫秒**。
 * 不加缓存的话，守护进程每 2 秒轮询一次就要等 3.6 秒 —— 「加卡瞬间生效」根本
 * 做不到，而且会持续打上游的 /v1/models。
 *
 * 缓存键含 id + baseUrl + apiKey：换了 key 或换了站点，模型列表可能完全不同，
 * 必须重新探。
 *
 * ── 缓存不存什么 ────────────────────────────────────────────
 *
 * 只存**探测成功**的原始结果。抖动兜底（并集）后的值不进缓存 —— 否则一次上游
 * 抖动会被永久固化成「正确结果」，以后再也降不下来。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 缓存过期时间：24 小时。上游上新模型后，最迟一天能自动发现。 */
const TTL_MS = 24 * 60 * 60 * 1000;

function load(file) {
	if (!existsSync(file)) return { version: 1, entries: {} };
	try {
		const j = JSON.parse(readFileSync(file, "utf8"));
		if (j?.version !== 1 || typeof j.entries !== "object") return { version: 1, entries: {} };
		return j;
	} catch {
		// 缓存坏了不是错误：丢弃重探即可，比让同步失败好
		return { version: 1, entries: {} };
	}
}

function save(file, data) {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(data, null, "\t")}\n`);
	} catch {
		// 写不了缓存不影响正确性，只是下轮要重探
	}
}

/**
 * 打开缓存。返回的对象可直接传给 planGroups 的 deps.cache。
 *
 * @param {string} file 缓存文件路径；传空则退化为纯内存
 * @param {{now?: () => number, ttlMs?: number}} [opts]
 */
export function openCache(file, opts = {}) {
	const now = opts.now ?? Date.now;
	const ttl = opts.ttlMs ?? TTL_MS;
	const data = file ? load(file) : { version: 1, entries: {} };
	let dirty = false;

	return {
		/** 命中且未过期才返回；否则 undefined（触发重探）。 */
		get(key) {
			const e = data.entries[key];
			if (!e || !Array.isArray(e.models) || !e.models.length) return undefined;
			if (now() - (e.at ?? 0) > ttl) return undefined;
			return e.models;
		},

		/** 只应在探测成功时调用。 */
		set(key, models) {
			if (!Array.isArray(models) || !models.length) return;
			data.entries[key] = { models: [...models], at: now() };
			dirty = true;
		},

		/** 清理已不存在的键，避免缓存无限增长。 */
		prune(liveKeys) {
			const keep = new Set(liveKeys);
			for (const k of Object.keys(data.entries)) {
				if (!keep.has(k)) {
					delete data.entries[k];
					dirty = true;
				}
			}
		},

		flush() {
			if (file && dirty) save(file, data);
			dirty = false;
		},

		/** 测试用：看当前有多少条。 */
		size() {
			return Object.keys(data.entries).length;
		},
	};
}
