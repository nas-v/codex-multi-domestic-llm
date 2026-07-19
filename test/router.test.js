import test from "node:test";
import assert from "node:assert/strict";
import { buildCallMetadata, routeModel } from "../src/router.js";
import { SectionExecutionStore } from "../src/section-execution.js";

test("explicit provider returns stable metadata without provider failover", async () => {
  const output = await routeModel({
    prompt: "hello",
    provider: "zhipu",
    mode: "compact",
    requestId: "req-explicit",
    invokeProvider: async (provider) => ({ result: "ok", model: `${provider}-model`, outputTokens: 768 })
  });

  assert.equal(output.requestId, "req-explicit");
  assert.equal(output.selectedProvider, "zhipu");
  assert.equal(output.fallbackType, "none");
  assert.deepEqual(output.attempts.map(({ provider, status }) => ({ provider, status })), [
    { provider: "zhipu", status: "success" }
  ]);
  assert.equal(buildCallMetadata(output).result, undefined);
});

test("auto records provider failover attempts", async () => {
  const output = await routeModel({
    prompt: "代码实现",
    provider: "auto",
    requestId: "req-auto",
    invokeProvider: async (provider) => {
      if (provider === "deepseek") {
        const error = new Error("Insufficient Balance");
        error.status = 402;
        throw error;
      }
      return { result: "fallback provider ok", model: `${provider}-model`, outputTokens: 768 };
    }
  });

  assert.equal(output.selectedProvider, "zhipu");
  assert.equal(output.fallbackType, "provider_failover");
  assert.equal(output.fallbackReason, "preferred_provider_failed");
  assert.deepEqual(output.attempts.map(({ provider, status }) => ({ provider, status })), [
    { provider: "deepseek", status: "error" },
    { provider: "zhipu", status: "success" }
  ]);
  assert.equal(output.attempts[0].errorCode, "QUOTA_EXCEEDED");
  assert.equal(output.attempts[0].retryable, false);
});

test("all provider failures produce a local fallback with complete attempts", async () => {
  const output = await routeModel({
    prompt: "普通问题",
    provider: "auto",
    requestId: "req-local",
    invokeProvider: async () => {
      throw new Error("offline");
    }
  });

  assert.equal(output.selectedProvider, "local");
  assert.equal(output.model, "fallback");
  assert.equal(output.fallbackType, "local_fallback");
  assert.equal(output.fallbackReason, "all_providers_failed");
  assert.equal(output.attempts.length, 4);
  assert.ok(output.attempts.every((attempt) => attempt.status === "error"));
  assert.ok(output.attempts.every((attempt) => attempt.errorCode === "UPSTREAM_ERROR"));
});

test("rejects invalid input and explicit providers with structured error codes", async () => {
  await assert.rejects(
    routeModel({ prompt: "", requestId: "req-empty" }),
    (error) => error.code === "INVALID_INPUT" && error.status === 400
  );
  await assert.rejects(
    routeModel({ prompt: "hello", provider: "unknown", requestId: "req-provider" }),
    (error) => error.code === "INVALID_PROVIDER" && error.status === 400
  );
});

test("rejects invalid mode, temperature and maxOutputTokens", async () => {
  for (const input of [
    { mode: "verbose" },
    { temperature: 2.1 },
    { temperature: "0.7" },
    { maxOutputTokens: 1.5 },
    { maxOutputTokens: 0 }
  ]) {
    await assert.rejects(
      routeModel({ prompt: "hello", provider: "zhipu", ...input }),
      (error) => error.code === "INVALID_PARAMETER" && error.status === 400
    );
  }
});

test("total deadline cancels provider work and prevents further failover", async () => {
  let calls = 0;
  const output = await routeModel({
    prompt: "普通问题",
    provider: "auto",
    totalTimeoutMs: 10,
    invokeProvider: async (...args) => {
      calls += 1;
      const { signal } = args.at(-1);
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  });
  assert.equal(calls, 1);
  assert.equal(output.fallbackType, "local_fallback");
  assert.equal(output.attempts[0].errorCode, "TIMEOUT");
});

test("concurrent requests keep request ids isolated", async () => {
  const invokeProvider = async (provider, prompt, mode, max, temperature, requestId) => ({
    result: `${requestId}:${prompt}`, model: `${provider}-model`, outputTokens: 10
  });
  const [first, second] = await Promise.all([
    routeModel({ prompt: "one", provider: "zhipu", requestId: "req-one", invokeProvider }),
    routeModel({ prompt: "two", provider: "zhipu", requestId: "req-two", invokeProvider })
  ]);
  assert.equal(first.result, "req-one:one");
  assert.equal(second.result, "req-two:two");
});

test("exposes normalized cache usage metadata", async () => {
  const output = await routeModel({
    prompt: "report", provider: "zhipu", requestId: "req-cache",
    invokeProvider: async () => ({
      result: "ok", model: "glm", outputTokens: 100,
      usage: { promptTokens: 1000, cachedPromptTokens: 750, cacheObserved: true, completionTokens: 100, reasoningTokens: 20, totalTokens: 1100, cacheHitRate: 0.75 }
    })
  });
  assert.equal(output.usage.cachedPromptTokens, 750);
  assert.equal(output.usage.cacheHitRate, 0.75);
  assert.equal(output.usage.cacheObserved, true);
  assert.equal(output.attempts[0].usage.cacheHitRate, 0.75);
});

test("propagates report correlation metadata without changing provider prompts", async () => {
  let invocation;
  const output = await routeModel({
    prompt: "section prompt", provider: "zhipu", requestId: "req-report",
    reportId: "report-2026", sectionId: "risk.1", stage: "section",
    invokeProvider: async (...args) => {
      invocation = args;
      return { result: "ok", model: "glm", outputTokens: 10 };
    }
  });
  assert.equal(invocation[1], "section prompt");
  assert.equal(invocation.at(-1).reportId, "report-2026");
  assert.equal(output.reportId, "report-2026");
  assert.equal(buildCallMetadata(output).sectionId, "risk.1");
});

test("rejects malformed or incomplete report correlation metadata", async () => {
  await assert.rejects(
    routeModel({ prompt: "hello", reportId: "bad report id" }),
    (error) => error.code === "INVALID_PARAMETER"
  );
  await assert.rejects(
    routeModel({ prompt: "hello", sectionId: "intro", stage: "section" }),
    (error) => error.code === "INVALID_PARAMETER"
  );
  await assert.rejects(
    routeModel({ prompt: "hello", reportId: "report-only", stage: "section" }),
    (error) => error.code === "INVALID_PARAMETER"
  );
});

test("duplicate report sections expose idempotency metadata without duplicate usage", async () => {
  const executionStore = new SectionExecutionStore();
  let calls = 0;
  const invokeProvider = async () => {
    calls += 1;
    return {
      result: "chapter",
      model: "glm-5.2",
      outputTokens: 100,
      usage: { promptTokens: 100, cachedPromptTokens: 80, cacheObserved: true, completionTokens: 20, reasoningTokens: 0, totalTokens: 120, cacheHitRate: 0.8 }
    };
  };
  const input = {
    prompt: "stable section",
    provider: "zhipu",
    reportId: "report-idem",
    sectionId: "intro",
    stage: "section",
    executionStore,
    invokeProvider
  };
  const first = await routeModel({ ...input, requestId: "req-first" });
  const repeated = await routeModel({ ...input, requestId: "req-repeat" });

  assert.equal(first.idempotencyStatus, "executed");
  assert.equal(repeated.idempotencyStatus, "reused");
  assert.equal(repeated.sourceRequestId, "req-first");
  assert.equal(first.idempotencyKey, repeated.idempotencyKey);
  assert.equal(first.usage.totalTokens, 120);
  assert.equal(repeated.usage.totalTokens, 0);
  assert.equal(calls, 1);
});
