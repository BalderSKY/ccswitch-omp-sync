/**
 * 主同步逻辑：CC Switch 卡 → omp models.yml。
 *
 * 纯函数化：不做 IO，输入配置与卡列表，输出要写入的内容。IO 在 cli.mjs。
 * 这样核心逻辑可以单测，不必碰真实数据库与文件系统。
 */

import { filterChatModels, probeModels } from "./probe.mjs";
import { tagOf } from "./ccswitch.mjs";
import { blockOf, findProvidersSection, joinLines, readPrevModels, rewriteProviders } from "./yaml.mjs";

/**
 * 决定一张卡在 models.yml 里的 provider id。
 *
 * 三种来源，优先级从高到低：
 *   1. 配置里的 fixedIds（omp 的 modelRoles 引用了这个名字，必须稳定）
 *   2. key 的前 4 位十六进制（稳定且可读，同一张卡永远同一个名）
 *   3. 卡 id 的哈希（key 不是 sk- 格式时的兜底）
 */
export function idOf(card, cfg) {
	if (card.app === "claude") return cfg.claudeProviderId ?? "cc-switch";
	const tag = tagOf(card.apiKey, card.id);
	const fixed = cfg.fixedIds?.[tag];
	if (fixed) return fixed;
	if (tag) return `ccs-${tag}`;
	// 稳定兜底：不用随机数，否则每轮同步都改名
	return `ccs-${Buffer.from(String(card.id)).toString("hex").slice(0, 4)}`;
}

/** 一张卡 → 写入 models.yml 的 provider 字段。 */
export function fieldsOf(card, cfg) {
	if (card.app === "claude") {
		return {
			name: card.name,
			baseUrl: cfg.proxyBase,
			apiKey: cfg.proxyKey,
			api: "anthropic-messages",
			// claude 卡的 baseUrl 只用于拉模型列表；实际请求走本地代理
			probeBase: card.baseUrl,
			probeKey: card.apiKey,
		};
	}
	return {
		name: card.name,
		// codex 的 base_url 通常不带 /v1（如 https://api.example.com）
		baseUrl: /\/v1$/i.test(card.baseUrl) ? card.baseUrl : `${card.baseUrl.replace(/\/+$/, "")}/v1`,
		apiKey: card.apiKey,
		api: "openai-responses",
		probeBase: card.baseUrl,
		probeKey: card.apiKey,
		pinned: card.pinned,
	};
}

/** host 白名单过滤；空数组表示全部放行。 */
export function hostAllowed(card, cfg) {
	if (!cfg.hosts?.length) return true;
	if (card.app === "claude") return true; // claude 面走代理，不限 host
	try {
		return cfg.hosts.includes(new URL(card.baseUrl).host);
	} catch {
		return false;
	}
}

/**
 * 计算本次要写的分组。
 *
 * @returns {{groups: object[], skipped: object[]}}
 */
export async function planGroups(cards, cfg, prevModels, deps = {}) {
	const probe = deps.probeModels ?? probeModels;
	const groups = [];
	const skipped = [];

	const selected = [];
	for (const card of cards) {
		if (card.app === "claude" && cfg.claudeCurrentOnly && !card.isCurrent) {
			skipped.push({ name: card.name, app: card.app, reason: "非当前卡（本地代理只转发当前卡）" });
			continue;
		}
		if (!hostAllowed(card, cfg)) {
			skipped.push({ name: card.name, app: card.app, reason: "不在 hosts 白名单" });
			continue;
		}
		selected.push({ card, f: fieldsOf(card, cfg), id: idOf(card, cfg) });
	}

	// 并发探测，避免一张卡慢拖住全部
	const probed = await Promise.all(
		selected.map(s => probe(s.f.probeBase, s.f.probeKey, cfg.probeTimeoutMs)),
	);

	for (let i = 0; i < selected.length; i++) {
		const { card, f, id } = selected[i];
		const p = probed[i];

		let ids = p.models;
		let note = p.note;

		// 探不到时用卡里 pin 的模型兜底，下轮补齐
		if (!ids.length && f.pinned) {
			ids = [f.pinned];
			note = `${note || "无列表"}，使用卡内 pin: ${f.pinned}`;
		}
		if (!ids.length) {
			skipped.push({ name: card.name, app: card.app, reason: note || "无模型列表" });
			continue;
		}

		const beforeFilter = ids.length;
		ids = filterChatModels(ids, cfg.nonChatPattern);
		if (beforeFilter > ids.length) {
			note = `${note ? `${note}；` : ""}滤掉 ${beforeFilter - ids.length} 个非对话模型`;
		}
		if (!ids.length) {
			skipped.push({ name: card.name, app: card.app, reason: "过滤后无对话模型" });
			continue;
		}

		/**
		 * 抖动保护：新结果比上次少时取并集。
		 *
		 * 上游会瞬时不稳（实测同卡一次 11 个、下一次退回 pin 只剩 1 个）。只覆盖
		 * 的话用户模型会凭空消失；并集最差是「多留一轮」，下一轮稳定后自然收敛。
		 */
		const prev = prevModels?.get(id);
		if (prev?.length && ids.length < prev.length) {
			const fresh = ids.length;
			ids = [...new Set([...prev, ...ids])];
			note = `${note ? `${note}；` : ""}只探到 ${fresh} 个（上次 ${prev.length} 个），沿用并集`;
		}

		groups.push({ id, f, ids, note, card });
	}

	return { groups, skipped };
}

/** 把分组渲染成 providers 段内的行。 */
export function renderBody(groups, cfg) {
	const blocks = groups.map(g =>
		blockOf(g.id, g.f, g.ids, {
			contextWindow: cfg.defaultContextWindow,
			maxTokens: cfg.defaultMaxTokens,
		}),
	);
	return blocks.flatMap((b, i) => (i ? ["", ...b] : b));
}

/**
 * 把新内容套进一份现有 models.yml 文本。
 *
 * @returns {{text: string, changed: boolean, error?: string}}
 */
export function applyToText(raw, groups, cfg) {
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const lines = raw.split(/\r?\n/);
	const section = findProvidersSection(lines);
	if (!section) return { text: raw, changed: false, error: "没有 providers: 段" };

	const body = renderBody(groups, cfg);
	const liveIds = groups.map(g => g.id);

	/**
	 * 历史遗留判定：`ccs-<4hex>` 或配置里的固定名。
	 * 卡删掉后这些块没有对应卡，不清理就会成为永久的孤儿分组。
	 */
	const extraManaged = id => /^ccs-[0-9a-f]{4}$/.test(id) || Object.values(cfg.fixedIds ?? {}).includes(id);

	const text = joinLines(rewriteProviders(lines, section, body, liveIds, extraManaged), eol);
	return { text, changed: text !== raw };
}

export { readPrevModels };
