import { createHash, randomUUID } from "node:crypto";

const ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const MODES = new Set(["compact", "normal", "detailed"]);

function assert(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: "INVALID_BASELINE" });
}

function emptyUsage() {
  return {
    promptTokens: 0,
    cachedPromptTokens: null,
    cacheObserved: false,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheHitRate: null
  };
}

function sampleHash(sample) {
  return createHash("sha256").update(JSON.stringify(sample)).digest("hex").slice(0, 16);
}

function validateCall(call, field, { section = false } = {}) {
  assert(call && typeof call === "object" && !Array.isArray(call), `${field} 必须是对象`);
  if (section) assert(typeof call.id === "string" && ID_PATTERN.test(call.id), `${field}.id 格式无效`);
  assert(typeof call.instruction === "string" && call.instruction.trim(), `${field}.instruction 不能为空`);
  assert(MODES.has(call.mode), `${field}.mode 无效`);
  assert(Number.isInteger(call.maxOutputTokens) && call.maxOutputTokens > 0, `${field}.maxOutputTokens 必须是正整数`);
}

export function validateBaselineSample(sample) {
  assert(sample && typeof sample === "object" && !Array.isArray(sample), "基线样本必须是对象");
  assert(sample.schemaVersion === 1, "当前只支持 schemaVersion=1");
  assert(typeof sample.sampleId === "string" && ID_PATTERN.test(sample.sampleId), "sampleId 格式无效");
  assert(typeof sample.sampleVersion === "string" && ID_PATTERN.test(sample.sampleVersion), "sampleVersion 格式无效");
  assert(typeof sample.title === "string" && sample.title.trim(), "title 不能为空");
  assert(typeof sample.sharedContext === "string" && sample.sharedContext.trim().length >= 1000, "sharedContext 至少需要 1000 个字符");
  validateCall(sample.plan, "plan");
  assert(Array.isArray(sample.sections) && sample.sections.length >= 2, "sections 至少需要两个章节");
  const ids = new Set();
  sample.sections.forEach((section, index) => {
    validateCall(section, `sections[${index}]`, { section: true });
    assert(!ids.has(section.id), `sectionId 重复: ${section.id}`);
    ids.add(section.id);
  });
  return sample;
}

export function buildBaselineCalls(sample) {
  validateBaselineSample(sample);
  const prefix = `${sample.title}\n\n${sample.sharedContext.trim()}\n\n`;
  return [
    {
      callId: "plan",
      stage: "plan",
      sectionId: null,
      mode: sample.plan.mode,
      maxOutputTokens: sample.plan.maxOutputTokens,
      prompt: `${prefix}基线任务：制定报告结构。\n${sample.plan.instruction.trim()}`
    },
    ...sample.sections.map((section) => ({
      callId: `section:${section.id}`,
      stage: "section",
      sectionId: section.id,
      mode: section.mode,
      maxOutputTokens: section.maxOutputTokens,
      prompt: `${prefix}基线任务：撰写章节 ${section.id}。\n${section.instruction.trim()}`
    }))
  ];
}

function safeAttempt(attempt = {}) {
  return {
    provider: attempt.provider || null,
    model: attempt.model || null,
    status: attempt.status || "unknown",
    durationMs: Number(attempt.durationMs) || 0,
    ...(attempt.statusCode ? { statusCode: attempt.statusCode } : {}),
    ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
    ...(typeof attempt.retryable === "boolean" ? { retryable: attempt.retryable } : {}),
    ...(attempt.idempotencyStatus ? { idempotencyStatus: attempt.idempotencyStatus } : {})
  };
}

function addUsage(total, usage = {}) {
  for (const field of ["promptTokens", "completionTokens", "reasoningTokens", "totalTokens"]) {
    total[field] += Number(usage[field]) || 0;
  }
  const observed = usage.cacheObserved === true || usage.cacheHitRate !== null && usage.cacheHitRate !== undefined;
  if (observed) {
    total.cacheObserved = true;
    total.cachedPromptTokens = (total.cachedPromptTokens ?? 0) + (Number(usage.cachedPromptTokens) || 0);
  }
}

function finishUsage(usage) {
  usage.cacheHitRate = usage.cacheObserved && usage.promptTokens > 0
    ? usage.cachedPromptTokens / usage.promptTokens
    : null;
  return usage;
}

export function parseBaselineArgs(argv) {
  const options = { live: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") options.live = true;
    else if (arg === "--dry-run") options.live = false;
    else if (["--provider", "--sample", "--output", "--report-id"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少参数`);
      options[arg.slice(2).replace("-", "_")] = value;
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (options.live) {
    if (!options.provider || options.provider === "auto") throw new Error("--live 必须指定非 auto 的 --provider");
    if (!options.output) throw new Error("--live 必须指定 --output 保存脱敏摘要");
  }
  if (options.report_id && !ID_PATTERN.test(options.report_id)) throw new Error("--report-id 格式无效");
  return options;
}

export async function runReportBaseline({
  sample,
  provider = "auto",
  live = false,
  route,
  reportId = `baseline:${sample?.sampleId || "sample"}:${Date.now()}`,
  now = Date.now,
  requestIdFactory = randomUUID
}) {
  validateBaselineSample(sample);
  assert(ID_PATTERN.test(reportId), "reportId 格式无效");
  if (live) {
    assert(provider && provider !== "auto", "真实基线必须明确指定 Provider");
    assert(typeof route === "function", "真实基线缺少路由执行器");
  }

  const calls = buildBaselineCalls(sample);
  const base = {
    schemaVersion: 1,
    sampleId: sample.sampleId,
    sampleVersion: sample.sampleVersion,
    sampleHash: sampleHash(sample),
    reportId,
    executionMode: live ? "live" : "dry-run",
    requestedProvider: provider,
    plannedCalls: calls.length
  };

  if (!live) {
    return {
      ...base,
      status: "ready",
      calls: calls.map(({ callId, stage, sectionId, mode, maxOutputTokens, prompt }) => ({
        callId,
        stage,
        ...(sectionId ? { sectionId } : {}),
        mode,
        maxOutputTokens,
        promptChars: prompt.length
      })),
      safety: { externalCalls: 0, storesPrompt: false, storesResponseText: false, storesCredentials: false }
    };
  }

  const startedAtMs = now();
  const records = [];
  for (const call of calls) {
    const callStartedAt = now();
    let output;
    try {
      output = await route({
        prompt: call.prompt,
        provider,
        mode: call.mode,
        maxOutputTokens: call.maxOutputTokens,
        temperature: 0.2,
        reportId,
        sectionId: call.sectionId || undefined,
        stage: call.stage,
        requestId: requestIdFactory()
      });
    } catch (error) {
      records.push({
        callId: call.callId,
        stage: call.stage,
        ...(call.sectionId ? { sectionId: call.sectionId } : {}),
        status: "failed",
        durationMs: Math.max(0, now() - callStartedAt),
        errorCode: error?.code || "BASELINE_CALL_FAILED"
      });
      break;
    }
    const succeeded = output.selectedProvider === provider && output.fallbackType === "none";
    const outputBudgetSaturated = Number(output.outputTokens) > 0
      && Number(output.usage?.completionTokens) >= Number(output.outputTokens);
    records.push({
      callId: call.callId,
      stage: call.stage,
      ...(call.sectionId ? { sectionId: call.sectionId } : {}),
      requestId: output.requestId,
      status: succeeded ? "success" : "failed",
      durationMs: Math.max(0, now() - callStartedAt),
      selectedProvider: output.selectedProvider,
      model: output.model,
      mode: output.mode,
      outputTokens: output.outputTokens,
      outputBudgetSaturated,
      usage: output.usage || emptyUsage(),
      attempts: (output.attempts || []).map(safeAttempt),
      fallbackType: output.fallbackType,
      ...(output.idempotencyStatus ? { idempotencyStatus: output.idempotencyStatus } : {})
    });
    if (!succeeded) break;
  }

  const completedAtMs = now();
  const usage = emptyUsage();
  for (const record of records) if (record.status === "success") addUsage(usage, record.usage);
  const durations = records.map((record) => record.durationMs).filter(Number.isFinite);
  const succeeded = records.filter((record) => record.status === "success").length;
  return {
    ...base,
    status: succeeded === calls.length ? "success" : succeeded > 0 ? "partial_success" : "failed",
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    completedCalls: records.length,
    succeededCalls: succeeded,
    failedCalls: records.filter((record) => record.status === "failed").length,
    performance: {
      callDurationMs: durations.reduce((sum, value) => sum + value, 0),
      averageCallDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      maxCallDurationMs: durations.length ? Math.max(...durations) : 0,
      budgetSaturatedCalls: records.filter((record) => record.outputBudgetSaturated).length
    },
    usage: finishUsage(usage),
    calls: records,
    safety: { storesPrompt: false, storesResponseText: false, storesCredentials: false }
  };
}
