import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  buildProviderRequestBody,
  executeWithRetry,
  normalizeUsage,
  PROVIDER_MAX_ATTEMPTS,
  readBoundedResponse
} from "../src/provider-client.js";
import { getProviderConfig } from "../src/config.js";

function response(chunks, contentLength) {
  return {
    headers: { get: (name) => name === "content-length" ? contentLength : null },
    body: Readable.from(chunks.map((chunk) => Buffer.from(chunk)))
  };
}

test("bounded upstream reader accepts responses within the limit", async () => {
  assert.equal(await readBoundedResponse(response(["hello"], "5"), 5), "hello");
});

test("bounded upstream reader rejects declared and streamed oversized responses", async () => {
  await assert.rejects(readBoundedResponse(response(["hello"], "5"), 4), (error) => error.code === "UPSTREAM_RESPONSE_TOO_LARGE");
  await assert.rejects(readBoundedResponse(response(["abc", "def"], null), 5), (error) => error.code === "UPSTREAM_RESPONSE_TOO_LARGE");
});

test("Kimi K2.6 request uses max_tokens, disables thinking and omits fixed temperature", () => {
  const config = getProviderConfig("kimi");
  const body = buildProviderRequestBody(config, "hello", "compact", 1024, 0.7);
  assert.equal(body.model, "kimi-k2.6");
  assert.equal(body.max_tokens, 1024);
  assert.equal("max_completion_tokens" in body, false);
  assert.equal("temperature" in body, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("normalizes Kimi top-level cached_tokens usage", () => {
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    cached_tokens: 750
  }), {
    promptTokens: 1000,
    cachedPromptTokens: 750,
    cacheObserved: true,
    completionTokens: 100,
    reasoningTokens: 0,
    totalTokens: 1100,
    cacheHitRate: 0.75
  });
});

test("provider retry uses bounded backoff and stops after success", async () => {
  let calls = 0;
  const waits = [];
  const result = await executeWithRetry(async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error("busy");
      error.status = 429;
      throw error;
    }
    return "ok";
  }, { delay: async (ms) => { waits.push(ms); } });
  assert.equal(result, "ok");
  assert.equal(calls, PROVIDER_MAX_ATTEMPTS);
  assert.deepEqual(waits, [1000, 2000]);
});

test("provider retry does not repeat non-retryable failures", async () => {
  let calls = 0;
  await assert.rejects(executeWithRetry(async () => {
    calls += 1;
    const error = new Error("invalid key");
    error.status = 401;
    throw error;
  }, { delay: async () => assert.fail("must not wait") }), /invalid key/);
  assert.equal(calls, 1);
});
