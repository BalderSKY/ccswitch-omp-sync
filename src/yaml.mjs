/**
 * models.yml 的读写。
 *
 * ── 只做「定点替换」，不做整段重写 ──────────────────────────
 *
 * omp 的 models.yml 里除了 `providers:` 还有用户手写的内容：
 *
 *   providers:
 *     my-manual:     ← 手工分组，不能被删
 *       ...
 *   modelRoles:      ← 段外内容，一字不能动
 *     default: my-manual/some-model
 *
 * 早期版本整段替换 `providers:`，把用户手写的分组静默删了。所以这里的原则是：
 * **只切自己认领的块，其余原样保留**。
 *
 * 认领范围 = 本次要写的 id ∪ 历史命名（`ccs-<4hex>` 与配置里的固定名）。
 * 后半不可省：卡删掉后对应的块会成孤儿，只按「现有卡」算永远清不掉。
 */

/** YAML 标量安全化。 */
export function yamlScalar(v) {
	const s = String(v);
	// 纯安全字符才裸写。注意 `[Cloud]GLM-5.3-Flash` 这类以 `[` 开头的一裸写
	// 就会被解析成数组，整个 provider 坏掉 —— 实测踩过。
	if (/^[A-Za-z0-9_./+-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return s;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 生成一个 provider 块（不含前后空行）。 */
export function blockOf(id, f, modelIds, opts = {}) {
	const ctx = opts.contextWindow ?? 1_000_000;
	const maxt = opts.maxTokens ?? 128_000;
	const lines = [
		`  ${yamlScalar(id)}:`,
		`    name: ${yamlScalar(f.name)}`,
		`    baseUrl: ${yamlScalar(f.baseUrl)}`,
		`    apiKey: ${yamlScalar(f.apiKey)}`,
		`    api: ${yamlScalar(f.api)}`,
		`    models:`,
	];
	for (const m of modelIds) {
		lines.push(
			`      - id: ${yamlScalar(m)}`,
			`        name: ${yamlScalar(m)}`,
			`        reasoning: true`,
			`        input: [text, image]`,
			`        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`,
			`        contextWindow: ${ctx}`,
			`        maxTokens: ${maxt}`,
		);
	}
	return lines;
}

/** 找出 `providers:` 段的 [start, end)。找不到返回 null。 */
export function findProvidersSection(lines) {
	const start = lines.findIndex(l => /^providers:\s*(#.*)?$/.test(l));
	if (start < 0) return null;
	let end = start + 1;
	while (end < lines.length && !/^\S/.test(lines[end])) end++;
	return { start, end };
}

/** 解析段内每个块的 [start, end) 与 id。 */
export function parseBlocks(lines, start, end) {
	const blocks = [];
	for (let i = start + 1; i < end; i++) {
		const m = /^  ([A-Za-z0-9_.\-]+):\s*$/.exec(lines[i]);
		if (!m) continue;
		let e = i + 1;
		while (e < end && !/^  \S/.test(lines[e])) e++;
		blocks.push({ id: m[1], start: i, end: e });
	}
	return blocks;
}

/**
 * 重写 providers 段：删掉受管块，插入新块，其余一行不动。
 *
 * @param {string[]} lines 全文按行切分
 * @param {{start:number,end:number}} section
 * @param {string[]} body 新的受管块（多块之间用空行分隔，调用方负责）
 * @param {string[]} liveIds 本次产出的 id
 * @param {(id:string)=>boolean} [extraManaged] 额外的「历史遗留」判定
 */
export function rewriteProviders(lines, section, body, liveIds, extraManaged) {
	const { start, end } = section;
	const managed = new Set(liveIds);
	// 历史命名：曾经的产物即使当前无对应卡也要清掉，否则删卡后留孤儿
	const isManaged = id => managed.has(id) || (extraManaged ? extraManaged(id) : false);

	const cuts = [];
	for (const b of parseBlocks(lines, start, end)) {
		if (!isManaged(b.id)) continue;
		let s = b.start;
		// 吞掉上方紧邻的缩进注释（那是分组标题）
		while (s - 1 > start && /^  #/.test(lines[s - 1])) s--;
		cuts.push([s, b.end]);
	}
	cuts.sort((a, b) => a[0] - b[0]);

	const kept = [];
	let i = start + 1;
	for (const [s, e] of cuts) {
		kept.push(...lines.slice(i, s));
		i = e;
	}
	kept.push(...lines.slice(i, end));

	const trimmed = kept.slice();
	while (trimmed.length && trimmed[trimmed.length - 1].trim() === "") trimmed.pop();

	return [
		...lines.slice(0, start + 1),
		"",
		...trimmed,
		...(trimmed.length ? [""] : []),
		...body,
		"",
		...lines.slice(end),
	];
}

/**
 * 从现有 models.yml 提取每个分组的模型 id，供探针抖动时兜底。
 *
 * 读一份就够：多份配置本应一致，不一致时下一轮同步会对齐。
 */
export function readPrevModels(text) {
	const lines = String(text).split(/\r?\n/);
	const section = findProvidersSection(lines);
	const out = new Map();
	if (!section) return out;
	for (const b of parseBlocks(lines, section.start, section.end)) {
		const ids = [];
		for (let i = b.start; i < b.end; i++) {
			const m = /^      - id: (.+)$/.exec(lines[i]);
			if (m) ids.push(m[1].replace(/^"|"$/g, ""));
		}
		out.set(b.id, ids);
	}
	return out;
}

/** 把行数组合成文本，顺便压掉 3 个以上连续空行。 */
export function joinLines(lines, eol) {
	return lines.join(eol).replace(/(\r?\n){3,}/g, eol + eol);
}
