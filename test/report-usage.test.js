import test from "node:test";
import assert from "node:assert/strict";
import { aggregateReportUsage, parseLogLines } from "../src/report-usage.js";

const observedUsage = {
  promptTokens: 1000,
  cachedPromptTokens: 800,
  cacheObserved: true,
  completionTokens: 200,
  reasoningTokens: 50,
  totalTokens: 1200,
  cacheHitRate: 0.8
};

test("parses JSONL while counting malformed lines", () => {
  const parsed = parseLogLines('{"message":"ok"}\nnot-json\n');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.invalidLines, 1);
});

test("aggregates report sections and observable cache usage", () => {
  const entries = [
    { reportId: "report-1", requestId: "plan", stage: "plan", message: "调用模型", provider: "zhipu" },
    { reportId: "report-1", requestId: "plan", stage: "plan", message: "调用成功", provider: "zhipu", usage: observedUsage },
    { reportId: "report-1", requestId: "section-1", stage: "section", sectionId: "intro", message: "调用模型", provider: "zhipu" },
    { reportId: "report-1", requestId: "section-1", stage: "section", sectionId: "intro", message: "调用成功", provider: "zhipu", usage: {
      promptTokens: 500, cachedPromptTokens: null, cacheObserved: false,
      completionTokens: 100, reasoningTokens: 0, totalTokens: 600, cacheHitRate: null
    } },
    { reportId: "report-1", requestId: "section-2", stage: "section", sectionId: "risk", message: "provider 调用失败，尝试下一个", errorCode: "TIMEOUT" },
    { reportId: "another", requestId: "ignored", message: "调用成功", usage: observedUsage }
  ];
  const report = aggregateReportUsage(entries, "report-1");
  assert.equal(report.status, "partial_success");
  assert.equal(report.calls, 3);
  assert.equal(report.succeeded, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.usage.promptTokens, 1500);
  assert.equal(report.usage.cachedPromptTokens, 800);
  assert.equal(report.usage.cacheHitRate, 0.8);
  assert.equal(report.sections.find((section) => section.sectionId === "risk").errorCode, "TIMEOUT");
});

test("returns not_found and an unobservable cache rate without matching logs", () => {
  const report = aggregateReportUsage([], "missing");
  assert.equal(report.status, "not_found");
  assert.equal(report.usage.cachedPromptTokens, null);
  assert.equal(report.usage.cacheHitRate, null);
});

test("recovery keeps one final section and excludes superseded usage", () => {
  const recoveredUsage = { ...observedUsage, promptTokens: 600, cachedPromptTokens: 300, totalTokens: 700, cacheHitRate: 0.5 };
  const entries = [
    { reportId: "report-recovery", requestId: "first", stage: "section", sectionId: "risk", message: "调用模型", provider: "zhipu", idempotencyKey: "key-1" },
    { reportId: "report-recovery", requestId: "first", stage: "section", sectionId: "risk", message: "provider 调用失败，尝试下一个", provider: "zhipu", errorCode: "TIMEOUT", idempotencyKey: "key-1" },
    { reportId: "report-recovery", requestId: "second", stage: "section", sectionId: "risk", message: "调用模型", provider: "zhipu", idempotencyKey: "key-1" },
    { reportId: "report-recovery", requestId: "second", stage: "section", sectionId: "risk", message: "调用成功", provider: "zhipu", usage: recoveredUsage, idempotencyKey: "key-1" },
    { reportId: "report-recovery", requestId: "third", stage: "section", sectionId: "risk", message: "章节调用复用", provider: "zhipu", idempotencyKey: "key-1", sourceRequestId: "second" }
  ];
  const report = aggregateReportUsage(entries, "report-recovery");
  assert.equal(report.status, "success");
  assert.equal(report.calls, 1);
  assert.equal(report.succeeded, 1);
  assert.equal(report.sections[0].attempts, 2);
  assert.deepEqual(report.sections[0].requestIds, ["first", "second", "third"]);
  assert.equal(report.usage.totalTokens, 700);
});
