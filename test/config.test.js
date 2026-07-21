import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProviderRuntimeConfig,
  getProviderCandidates,
  getProviderConfig,
  listProviderDefinitions,
  listProviders,
  resolveProviderAlias,
  resolveProviderOutputTokens
  , validateProvidersDocument
} from "../src/config.js";
import { PROVIDER_MAX_ATTEMPTS } from "../src/provider-client.js";
import { DEFAULT_TOTAL_TIMEOUT_MS } from "../src/router.js";

test("provider aliases resolve deterministically", () => {
  assert.equal(resolveProviderAlias("智谱"), "zhipu");
  assert.equal(resolveProviderAlias("glm"), "zhipu");
  assert.equal(resolveProviderAlias("DEEPSEEK"), "deepseek");
  assert.equal(resolveProviderAlias("文心"), "qianfan");
  assert.equal(resolveProviderAlias("月之暗面"), "kimi");
  assert.equal(resolveProviderAlias("unknown"), null);
});

test("explicit provider remains strict and auto retains fallbacks", () => {
  assert.deepEqual(getProviderCandidates("zhipu", "代码"), ["zhipu"]);
  const candidates = getProviderCandidates("auto", "代码");
  assert.equal(candidates[0], "deepseek");
  assert.deepEqual(new Set(candidates), new Set(listProviders()));
});

test("output policy adapts to each provider and clamps explicit values", () => {
  assert.equal(resolveProviderOutputTokens("zhipu", "compact"), 1024);
  assert.equal(resolveProviderOutputTokens("zhipu", "detailed"), 4096);
  assert.equal(resolveProviderOutputTokens("zhipu", "compact", 64), 768);
  assert.equal(resolveProviderOutputTokens("deepseek", "compact"), 512);
  assert.equal(resolveProviderOutputTokens("deepseek", "detailed"), 2048);
  assert.equal(resolveProviderOutputTokens("deepseek", "compact", 9999), 4096);
});

test("zhipu baseline tuning preserves timeout safety margins", () => {
  const zhipu = getProviderConfig("zhipu");
  assert.equal(zhipu.outputPolicy.compact, 1024);
  assert.equal(zhipu.outputPolicy.normal, 2048);
  assert.equal(zhipu.timeout, 45000);
  assert.equal(DEFAULT_TOTAL_TIMEOUT_MS, 55000);
  assert.ok(zhipu.timeout < DEFAULT_TOTAL_TIMEOUT_MS);
  assert.equal(PROVIDER_MAX_ATTEMPTS, 3);
});

test("provider capabilities are exposed from configuration", () => {
  assert.equal(getProviderConfig("zhipu").capabilities.reasoning, true);
  assert.equal(getProviderConfig("deepseek").capabilities.code, true);
  assert.equal(getProviderConfig("qianfan").capabilities.longContext, true);
  assert.equal(getProviderConfig("kimi").capabilities.contextCache, true);
  assert.equal(getProviderConfig("kimi").request.maxOutputTokensField, "max_tokens");
  assert.equal(getProviderConfig("kimi").request.extraBody.thinking.type, "disabled");
});

test("model profiles switch request contracts without provider-specific code", () => {
  const kimi = listProviderDefinitions().find(({ id }) => id === "kimi");
  const standard = buildProviderRuntimeConfig(kimi, {});
  assert.equal(standard.model, "kimi-k2.6");
  assert.deepEqual(standard.request.extraBody.thinking, { type: "disabled" });

  const code = buildProviderRuntimeConfig(kimi, { KIMI_MODEL: "kimi-k2.7-code" });
  assert.equal(code.model, "kimi-k2.7-code");
  assert.equal(code.request.extraBody.thinking, undefined);
  assert.deepEqual(code.request.omitParameters, ["temperature"]);
  assert.throws(
    () => buildProviderRuntimeConfig(kimi, { KIMI_MODEL: "unknown-model" }),
    /没有声明 modelProfiles/
  );
});

test("every provider definition produces a complete runtime contract", () => {
  const definitions = listProviderDefinitions();
  assert.equal(definitions.length, listProviders().length);
  for (const definition of definitions) {
    const config = getProviderConfig(definition.id);
    assert.ok(config, `${definition.id} should be enabled`);
    assert.equal(config.protocol, "openai-chat-completions");
    assert.ok(config.keyEnv.length > 0);
    assert.ok(config.request.maxOutputTokensField);
    assert.ok(config.outputPolicy.minimum <= config.outputPolicy.compact);
    assert.ok(config.outputPolicy.compact <= config.outputPolicy.maximum);
    for (const alias of config.aliases) assert.equal(resolveProviderAlias(alias), definition.id);
  }
});

test("provider snapshot is immutable", () => {
  assert.equal(Object.isFrozen(getProviderConfig("zhipu")), true);
  assert.equal(Object.isFrozen(getProviderConfig("zhipu").outputPolicy), true);
});

test("provider schema rejects unsafe URLs and invalid regular expressions", () => {
  const base = {
    id: "demo",
    name: "Demo",
    endpoint: { protocol: "openai-chat-completions", baseUrl: "https://example.com/v1/chat/completions" },
    model: "demo",
    credentials: { envKeys: ["DEMO_KEY"] },
    capabilities: { reasoning: false },
    limits: {
      contextChars: 1000,
      timeoutMs: 1000,
      outputTokens: { compact: 100, normal: 200, detailed: 300, minimum: 50, maximum: 500 }
    },
    routing: { aliases: [], keywords: [], priority: 10 }
  };
  assert.throws(() => validateProvidersDocument({ providers: [{ ...base, endpoint: { ...base.endpoint, baseUrl: "file:///tmp/key" } }] }), /http\/https/);
  assert.throws(() => validateProvidersDocument({ providers: [{ ...base, routing: { ...base.routing, keywords: ["["] } }] }), /无效正则/);
  assert.throws(() => validateProvidersDocument({ providers: [{ ...base, limits: { ...base.limits, timeoutMs: 0 } }] }), /正整数/);
  assert.throws(() => validateProvidersDocument({ providers: [base, { ...base, id: "other", routing: { ...base.routing, aliases: ["Demo"] } }] }), /别名冲突/);
});
