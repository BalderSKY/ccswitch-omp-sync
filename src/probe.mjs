/**
 * 探模型列表。
 *
 * codex 卡不存模型列表（codex 自己拉），所以必须探一次，否则 omp 里分组存在但
 * 一个模型都选不了。
 *
 * ── 两个必须处理的坑 ────────────────────────────────────────
 *
 * 1. **URL 不能盲目拼 `/v1`**
 *    claude 卡的 `ANTHROPIC_BASE_URL` 常常已经带 `/v1`（如
 *    `https://cdn.example.cn/v1`）。再拼 `/v1/models` 得到 `/v1/v1/models` → 404。
 *    实测同一张卡：`/v1/v1/models`=404，`/v1/models`=200。
 *
 * 2. **结果会抖**
 *    同一条命令连跑三次，可能一次拿到 11 个模型、下一次超时。若不处理，用户
 *    选择器里的模型会凭空少一堆。调用方用并集兜底（见 sync.mjs）。
 */

/** 拼出模型列表 URL，容忍 base 已带 `/v1` 或 `/v1/`。 */
export function modelsUrl(base) {
	const b = String(base || "").replace(/\/+$/, "");
	if (/\/v1$/i.test(b)) return `${b}/models`;
	if (/\/v1\/models$/i.test(b)) return b;
	return `${b}/v1/models`;
}

/**
 * @returns {{models: string[], note: string, ok: boolean}}
 */
export async function probeModels(base, key, timeoutMs = 15_000, fetchImpl = fetch) {
	if (!base || !key) return { models: [], note: "缺 base/key", ok: false };
	const url = modelsUrl(base);

	let res;
	try {
		res = await fetchImpl(url, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		return { models: [], note: `请求失败: ${String(error.message || error).slice(0, 60)}`, ok: false };
	}

	if (!res.ok) return { models: [], note: `HTTP ${res.status}`, ok: false };

	let json;
	try {
		json = await res.json();
	} catch {
		return { models: [], note: "响应不是 JSON", ok: false };
	}

	// OpenAI 风格是 {data: [...]}；部分中转站给 {models: [...]} 或裸数组
	const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : json?.models;
	if (!Array.isArray(list)) return { models: [], note: "响应里找不到模型数组", ok: false };

	const models = list
		.map(m => (typeof m === "string" ? m : (m?.id ?? m?.name)))
		.filter(x => typeof x === "string" && x && !/\s/.test(x));

	return { models, note: "", ok: true };
}

/** 过滤掉不能当对话模型用的条目（图片 / 向量 / 扩散）。 */
export function filterChatModels(models, pattern) {
	let re;
	try {
		re = new RegExp(pattern, "i");
	} catch {
		return models; // 用户给的正则坏了：不过滤，比误删好
	}
	return models.filter(x => !re.test(x));
}
