/**
 * 核心逻辑单测：不碰真实数据库与文件系统。
 *
 * 重点覆盖**曾经真出过 bug 的地方**，而不是追求覆盖率数字：
 *   - 手工分组不能被删（整段替换踩过）
 *   - 孤儿块要清掉（删卡后残留踩过）
 *   - 带特殊字符的模型 id 要加引号（[Cloud]... 被解析成数组踩过）
 *   - 探针 URL 不能重复拼 /v1（/v1/v1/models 404 踩过）
 *   - 抖动时不缩减模型列表（11 个塌成 1 个踩过）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { tagOf } from "../src/ccswitch.mjs";
import { modelsUrl } from "../src/probe.mjs";
import { filterChatModels } from "../src/probe.mjs";
import { applyToText, idOf, planGroups } from "../src/sync.mjs";
import { findProvidersSection, yamlScalar } from "../src/yaml.mjs";

const CFG = {
	hosts: [],
	fixedIds: {},
	claudeCurrentOnly: true,
	proxyBase: "http://127.0.0.1:15721",
	proxyKey: "local",
	defaultContextWindow: 1_000_000,
	defaultMaxTokens: 128_000,
	nonChatPattern: "embedding|diffusion|(^|[-/])image|(^|[-/])dall-e",
	probeTimeoutMs: 1000,
};

const card = (over = {}) => ({
	id: "card-1",
	name: "测试卡",
	app: "codex",
	isCurrent: false,
	baseUrl: "https://api.example.com",
	apiKey: "sk-abcd1234",
	pinned: "",
	...over,
});

// ── yamlScalar ─────────────────────────────────────────────

test("yamlScalar: 特殊字符加引号，避免被解析成数组", () => {
	// 裸写 `[Cloud]X` 会被 YAML 当成数组 —— 实测让整个 provider 坏掉
	assert.equal(yamlScalar("[Cloud]GLM-5.3-Flash"), '"[Cloud]GLM-5.3-Flash"');
	assert.equal(yamlScalar("[AN]gemini-3.8"), '"[AN]gemini-3.8"');
	assert.equal(yamlScalar("plain-model"), "plain-model");
	assert.equal(yamlScalar("gpt-5.6-sol"), "gpt-5.6-sol");
	// 布尔字面量必须加引号，否则 YAML 会读成 bool
	assert.equal(yamlScalar("true"), '"true"');
	assert.equal(yamlScalar("no"), '"no"');
	// 引号与反斜杠要转义
	assert.equal(yamlScalar('a"b'), '"a\\"b"');
	assert.equal(yamlScalar("a\\b"), '"a\\\\b"');
});

// ── modelsUrl ──────────────────────────────────────────────

test("modelsUrl: base 已带 /v1 时不重复拼接", () => {
	assert.equal(modelsUrl("https://x.com"), "https://x.com/v1/models");
	assert.equal(modelsUrl("https://x.com/"), "https://x.com/v1/models");
	// 关键回归：claude 卡的 ANTHROPIC_BASE_URL 常带 /v1
	assert.equal(modelsUrl("https://x.com/v1"), "https://x.com/v1/models");
	assert.equal(modelsUrl("https://x.com/v1/"), "https://x.com/v1/models");
	assert.equal(modelsUrl("https://x.com/v1/models"), "https://x.com/v1/models");
});

// ── tagOf / idOf ───────────────────────────────────────────

test("tagOf: 取 key 前 4 位十六进制", () => {
	assert.equal(tagOf("sk-abcd1234"), "abcd");
	assert.equal(tagOf("sk-5F06ffff"), "5f06");
	// 非 sk- 前缀：用字节的十六进制兜底
	assert.equal(tagOf("zz22"), "7a7a");
	assert.equal(tagOf(""), "");
});

test("idOf: 固定名优先，其次哈希名，且稳定", () => {
	const cfg = { ...CFG, fixedIds: { "5f06": "vulcan" } };
	assert.equal(idOf(card({ apiKey: "sk-5f06aa" }), cfg), "vulcan");
	assert.equal(idOf(card({ apiKey: "sk-3b32aa" }), cfg), "ccs-3b32");
	// claude 面固定一个名字
	assert.equal(idOf(card({ app: "claude", apiKey: "sk-9999" }), cfg), "cc-switch");
	// 同一个 key 多次调用结果一致（不能用随机/时间）
	const a = idOf(card({ apiKey: "sk-1111aa" }), cfg);
	const b = idOf(card({ apiKey: "sk-1111aa" }), cfg);
	assert.equal(a, b);
});

// ── filterChatModels ──────────────────────────────────────

test("filterChatModels: 滤掉图片/向量模型，保留对话模型", () => {
	const input = [
		"gpt-5.6-sol",
		"gpt-image-1",
		"gpt-image-2.5-flare",
		"gemini-embedding-2",
		"nai-diffusion-4-5-full:k_euler",
		"dall-e-3",
		"gpt-6-astra",
	];
	const out = filterChatModels(input, CFG.nonChatPattern);
	assert.deepEqual(out, ["gpt-5.6-sol", "gpt-6-astra"]);
});

test("filterChatModels: 正则坏了就不过滤，而不是清空", () => {
	const input = ["a", "b"];
	assert.deepEqual(filterChatModels(input, "([unclosed"), input);
});

// ── applyToText ───────────────────────────────────────────

const BASE_YML = `providers:
  # ── 手工分组 ──
  my-manual:
    name: 手工
    baseUrl: https://manual.example/v1
    apiKey: sk-manual
    api: openai-completions
    models:
      - id: manual-1
        name: manual-1

modelRoles:
  default: my-manual/manual-1
`;

test("applyToText: 保留手工分组与段外 modelRoles", () => {
	const groups = [
		{ id: "ccs-abcd", f: { name: "A", baseUrl: "https://a/v1", apiKey: "k", api: "openai-responses" }, ids: ["m1"] },
	];
	const { text, changed } = applyToText(BASE_YML, groups, CFG);
	assert.ok(changed);
	assert.match(text, /my-manual:/);
	assert.match(text, /manual-1/);
	assert.match(text, /modelRoles:/);
	assert.match(text, /default: my-manual\/manual-1/);
	assert.match(text, /ccs-abcd:/);
});

test("applyToText: 清掉孤儿块（卡已删除的 ccs- 分组）", () => {
	const withOrphan = BASE_YML.replace(
		"modelRoles:",
		`  ccs-dead:
    name: 已删的卡
    baseUrl: https://dead/v1
    apiKey: k
    api: openai-responses
    models:
      - id: gone

modelRoles:`,
	);
	const groups = [
		{ id: "ccs-abcd", f: { name: "A", baseUrl: "https://a/v1", apiKey: "k", api: "openai-responses" }, ids: ["m1"] },
	];
	const { text } = applyToText(withOrphan, groups, CFG);
	assert.doesNotMatch(text, /ccs-dead/);
	assert.doesNotMatch(text, /gone/);
	assert.match(text, /ccs-abcd/);
	assert.match(text, /my-manual:/);
});

test("applyToText: 同样的输入二次应用不再变化（幂等）", () => {
	const groups = [
		{ id: "ccs-abcd", f: { name: "A", baseUrl: "https://a/v1", apiKey: "k", api: "openai-responses" }, ids: ["m1"] },
	];
	const once = applyToText(BASE_YML, groups, CFG);
	const twice = applyToText(once.text, groups, CFG);
	assert.equal(twice.text, once.text);
	assert.equal(twice.changed, false);
});

test("applyToText: 没有 providers 段时明确报错，不瞎写", () => {
	const { changed, error } = applyToText("modelRoles:\n  default: x\n", [], CFG);
	assert.equal(changed, false);
	assert.match(error, /providers/);
});

test("applyToText: 带特殊字符的模型 id 被正确引用", () => {
	const groups = [
		{
			id: "ccs-abcd",
			f: { name: "A", baseUrl: "https://a/v1", apiKey: "k", api: "openai-responses" },
			ids: ["[Cloud]GLM-5.3-Flash"],
		},
	];
	const { text } = applyToText(BASE_YML, groups, CFG);
	assert.match(text, /- id: "\[Cloud\]GLM-5\.3-Flash"/);
});

// ── planGroups ────────────────────────────────────────────

const fakeProbe = result => async () => result;

test("planGroups: 探针失败时用卡内 pin 兜底", async () => {
	const cards = [card({ pinned: "gpt-5.5" })];
	const { groups, skipped } = await planGroups(cards, CFG, new Map(), {
		probeModels: fakeProbe({ models: [], note: "HTTP 500", ok: false }),
	});
	assert.equal(skipped.length, 0);
	assert.deepEqual(groups[0].ids, ["gpt-5.5"]);
	assert.match(groups[0].note, /pin/);
});

test("planGroups: 既无列表又无 pin 才跳过，并说明原因", async () => {
	const { groups, skipped } = await planGroups([card({ pinned: "" })], CFG, new Map(), {
		probeModels: fakeProbe({ models: [], note: "HTTP 500", ok: false }),
	});
	assert.equal(groups.length, 0);
	assert.match(skipped[0].reason, /HTTP 500/);
});

test("planGroups: 抖动时不缩减模型列表（取并集）", async () => {
	const prev = new Map([["ccs-abcd", ["m1", "m2", "m3", "m4"]]]);
	const { groups } = await planGroups([card()], CFG, prev, {
		probeModels: fakeProbe({ models: ["m1"], note: "", ok: true }),
	});
	assert.equal(groups[0].ids.length, 4, "应沿用上次的 4 个而不是塌回 1 个");
	assert.deepEqual(groups[0].ids, ["m1", "m2", "m3", "m4"]);
});

test("planGroups: 探到更多时正常增长，不被旧值限制", async () => {
	const prev = new Map([["ccs-abcd", ["m1"]]]);
	const { groups } = await planGroups([card()], CFG, prev, {
		probeModels: fakeProbe({ models: ["m1", "m2", "m3"], note: "", ok: true }),
	});
	assert.equal(groups[0].ids.length, 3);
});

test("planGroups: claude 面只导当前卡", async () => {
	const cards = [
		card({ id: "c1", name: "旧卡", app: "claude", isCurrent: false }),
		card({ id: "c2", name: "当前卡", app: "claude", isCurrent: true, apiKey: "sk-aaaa" }),
	];
	const { groups, skipped } = await planGroups(cards, CFG, new Map(), {
		probeModels: fakeProbe({ models: ["claude-x"], note: "", ok: true }),
	});
	assert.equal(groups.length, 1);
	assert.equal(groups[0].f.name, "当前卡");
	assert.match(skipped[0].reason, /非当前卡/);
});

test("planGroups: hosts 白名单生效", async () => {
	const cfg = { ...CFG, hosts: ["allowed.example"] };
	const cards = [
		card({ id: "a", name: "允许", baseUrl: "https://allowed.example" }),
		card({ id: "b", name: "拦截", baseUrl: "https://blocked.example" }),
	];
	const { groups, skipped } = await planGroups(cards, cfg, new Map(), {
		probeModels: fakeProbe({ models: ["m"], note: "", ok: true }),
	});
	assert.equal(groups.length, 1);
	assert.equal(groups[0].f.name, "允许");
	assert.match(skipped[0].reason, /白名单/);
});

test("planGroups: 过滤后只剩非对话模型时跳过整张卡", async () => {
	const { groups, skipped } = await planGroups([card()], CFG, new Map(), {
		probeModels: fakeProbe({ models: ["gpt-image-1", "dall-e-3"], note: "", ok: true }),
	});
	assert.equal(groups.length, 0);
	assert.match(skipped[0].reason, /过滤后无对话模型/);
});

// ── 段定位 ────────────────────────────────────────────────

test("findProvidersSection: 容忍行尾注释，且不吃段外内容", () => {
	const lines = ["# 头", "providers:  # 主配置", "  a:", "    x: 1", "", "modelRoles:", "  d: a/x"];
	const s = findProvidersSection(lines);
	assert.deepEqual(s, { start: 1, end: 5 });
});

// ── 模型列表缓存 ──────────────────────────────────────────

test("openCache: 命中后不再调用探针", async () => {
	const { openCache } = await import("../src/cache.mjs");
	const cache = openCache(""); // 纯内存
	let called = 0;
	const counting = async () => {
		called++;
		return { models: ["m1", "m2"], note: "", ok: true };
	};
	const cards = [card()];

	const first = await planGroups(cards, CFG, new Map(), { probeModels: counting, cache });
	assert.equal(called, 1);
	assert.deepEqual(first.groups[0].ids, ["m1", "m2"]);
	assert.equal(first.groups[0].viaCache, false);

	const second = await planGroups(cards, CFG, new Map(), { probeModels: counting, cache });
	assert.equal(called, 1, "第二轮应命中缓存，不该再探");
	assert.deepEqual(second.groups[0].ids, ["m1", "m2"]);
	assert.equal(second.groups[0].viaCache, true);
});

test("openCache: 换 key 使缓存失效（模型列表可能不同）", async () => {
	const { openCache } = await import("../src/cache.mjs");
	const cache = openCache("");
	let called = 0;
	const counting = async () => {
		called++;
		return { models: ["m"], note: "", ok: true };
	};
	await planGroups([card()], CFG, new Map(), { probeModels: counting, cache });
	await planGroups([card({ apiKey: "sk-9999" })], CFG, new Map(), { probeModels: counting, cache });
	assert.equal(called, 2, "换 key 后应重新探测");
});

test("openCache: 换 baseUrl 使缓存失效", async () => {
	const { openCache } = await import("../src/cache.mjs");
	const cache = openCache("");
	let called = 0;
	const counting = async () => {
		called++;
		return { models: ["m"], note: "", ok: true };
	};
	await planGroups([card()], CFG, new Map(), { probeModels: counting, cache });
	await planGroups([card({ baseUrl: "https://other.example.com" })], CFG, new Map(), {
		probeModels: counting,
		cache,
	});
	assert.equal(called, 2, "换站点后应重新探测");
});

test("openCache: 探测失败的结果不进缓存（避免固化失败）", async () => {
	const { openCache } = await import("../src/cache.mjs");
	const cache = openCache("");
	let called = 0;
	const failing = async () => {
		called++;
		return { models: [], note: "HTTP 500", ok: false };
	};
	await planGroups([card()], CFG, new Map(), { probeModels: failing, cache });
	await planGroups([card()], CFG, new Map(), { probeModels: failing, cache });
	assert.equal(called, 2, "失败不该被缓存，下轮要重试");
});

test("openCache: 抖动兜底后的并集不进缓存", async () => {
	const { openCache } = await import("../src/cache.mjs");
	const cache = openCache("");
	const prev = new Map([["ccs-abcd", ["m1", "m2", "m3"]]]);
	// 探到 1 个 → 并集变 3 个，但缓存里应只存探到的 1 个
	await planGroups([card()], CFG, prev, {
		probeModels: async () => ({ models: ["m1"], note: "", ok: true }),
		cache,
	});
	const key = "ccs-abcd\u0000https://api.example.com\u0000sk-abcd1234";
	assert.deepEqual(cache.get(key), ["m1"], "缓存存原始探测值，不存并集");
});

test("openCache: TTL 过期后重探", async () => {
	const { openCache } = await import("../src/cache.mjs");
	let t = 1000;
	const cache = openCache("", { now: () => t, ttlMs: 100 });
	let called = 0;
	const counting = async () => {
		called++;
		return { models: ["m"], note: "", ok: true };
	};
	await planGroups([card()], CFG, new Map(), { probeModels: counting, cache });
	t = 1050;
	await planGroups([card()], CFG, new Map(), { probeModels: counting, cache });
	assert.equal(called, 1, "TTL 内命中");
	t = 1200;
	await planGroups([card()], CFG, new Map(), { probeModels: counting, cache });
	assert.equal(called, 2, "过期后重探");
});

test("openCache: prune 清掉不再使用的键", async () => {
	const { openCache } = await import("../src/cache.mjs");
	const cache = openCache("");
	cache.set("dead\u0000x\u0000y", ["m"]);
	assert.equal(cache.size(), 1);
	cache.prune(["other\u0000x\u0000y"]);
	assert.equal(cache.size(), 0);
});

test("openCache: 落盘后重新打开仍命中", async () => {
	const { openCache } = await import("../src/cache.mjs");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "ccsc-"));
	const file = join(dir, "models.json");
	try {
		const a = openCache(file);
		a.set("k\u0000u\u0000s", ["x", "y"]);
		a.flush();

		const b = openCache(file);
		assert.deepEqual(b.get("k\u0000u\u0000s"), ["x", "y"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("openCache: 缓存文件损坏时当作空缓存，不抛错", async () => {
	const { openCache } = await import("../src/cache.mjs");
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "ccsc-"));
	const file = join(dir, "models.json");
	try {
		writeFileSync(file, "{ 这不是 JSON");
		const c = openCache(file);
		assert.equal(c.size(), 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
