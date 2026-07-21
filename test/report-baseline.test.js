import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaselineCalls, parseBaselineArgs, runReportBaseline, validateBaselineSample } from "../src/report-baseline.js";

const sample = {
  schemaVersion: 1,
  sampleId: "sample",
  sampleVersion: "1.0.0",
  title: "Stable baseline",
  sharedContext: "x".repeat(1200),
  plan: { mode: "compact", maxOutputTokens: 100, instruction: "plan" },
  sections: [
    { id: "one", mode: "normal", maxOutputTokens: 200, instruction: "first" },
    { id: "two", mode: "normal", maxOutputTokens: 200, instruction: "second" }
  ]
};

test("baseline sample produces calls with an identical stable prefix", () => {
  assert.equal(validateBaselineSample(sample), sample);
  const calls = buildBaselineCalls(sample);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.prompt.startsWith(`${sample.title}\n\n${sample.sharedContext}`)));
  assert.throws(() => validateBaselineSample({ ...sample, sharedContext: "short" }), /至少需要 1000/);
});

test("dry-run baseline never invokes a provider or stores prompt text", async () => {
  const summary = await runReportBaseline({
    sample,
    provider: "zhipu",
    live: false,
    reportId: "baseline:dry",
    route: async () => { throw new Error("must not run"); }
  });
  assert.equal(summary.status, "ready");
  assert.equal(summary.safety.externalCalls, 0);
  assert.equal(summary.calls.length, 3);
  assert.equal(JSON.stringify(summary).includes(sample.sharedContext), false);
});

test("live baseline returns only sanitized metrics and aggregated usage", async () => {
  let clock = 0;
  let calls = 0;
  const summary = await runReportBaseline({
    sample,
    provider: "zhipu",
    live: true,
    reportId: "baseline:live",
    now: () => { clock += 10; return clock; },
    requestIdFactory: () => `request-${++calls}`,
    route: async ({ requestId, stage, mode }) => ({
      requestId,
      requestedProvider: "zhipu",
      selectedProvider: "zhipu",
      provider: "zhipu",
      model: "glm-test",
      mode,
      outputTokens: 100,
      usage: { promptTokens: 100, cachedPromptTokens: 50, cacheObserved: true, completionTokens: 20, reasoningTokens: 5, totalTokens: 120, cacheHitRate: 0.5 },
      attempts: [{ provider: "zhipu", model: "glm-test", status: "success", durationMs: 8, error: "secret-token" }],
      fallbackType: "none",
      fallbackReason: null,
      result: `private response ${stage}`
    })
  });
  assert.equal(summary.status, "success");
  assert.equal(summary.usage.totalTokens, 360);
  assert.equal(summary.usage.cacheHitRate, 0.5);
  assert.equal(summary.performance.maxCallDurationMs, 10);
  assert.equal(summary.performance.budgetSaturatedCalls, 0);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("private response"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes(sample.sharedContext), false);
});

test("live CLI arguments require an explicit provider and output path", () => {
  assert.deepEqual(parseBaselineArgs(["--dry-run"]), { live: false });
  assert.throws(() => parseBaselineArgs(["--live", "--provider", "auto", "--output", "x.json"]), /非 auto/);
  assert.throws(() => parseBaselineArgs(["--live", "--provider", "zhipu"]), /--output/);
  assert.deepEqual(parseBaselineArgs(["--live", "--provider", "zhipu", "--output", "result.json"]), {
    live: true, provider: "zhipu", output: "result.json"
  });
});

test("baseline CLI reports invalid live arguments with exit code 2", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(process.execPath, ["scripts/report-baseline.mjs", "--live", "--provider", "zhipu"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--output/);
});
