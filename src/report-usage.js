function emptyUsage() {
  return {
    promptTokens: 0,
    cachedPromptTokens: null,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheObserved: false,
    cacheHitRate: null
  };
}

export function parseLogLines(text) {
  const entries = [];
  let invalidLines = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { invalidLines += 1; }
  }
  return { entries, invalidLines };
}

export function aggregateReportUsage(entries, reportId) {
  const relevant = entries.filter((entry) => entry?.reportId === reportId);
  const executions = new Map();
  for (const entry of relevant) {
    if (!entry.requestId) continue;
    const executionKey = entry.sectionId
      ? `section:${entry.sectionId}`
      : entry.stage === "plan"
        ? `plan:${entry.requestId}`
        : `request:${entry.requestId}`;
    const current = executions.get(executionKey) || {
      executionKey,
      requestId: entry.requestId,
      requestIds: [],
      sectionId: entry.sectionId || null,
      stage: entry.stage || null,
      provider: entry.provider || null,
      model: entry.model || null,
      idempotencyKey: entry.idempotencyKey || null,
      status: "incomplete",
      errorCode: null,
      usage: null,
      attempts: 0
    };
    if (!current.requestIds.includes(entry.requestId)) current.requestIds.push(entry.requestId);
    current.requestId = entry.requestId;
    current.sectionId ||= entry.sectionId || null;
    current.stage ||= entry.stage || null;
    current.provider = entry.provider || current.provider;
    current.model = entry.model || current.model;
    current.idempotencyKey = entry.idempotencyKey || current.idempotencyKey;
    if (entry.message === "调用模型" || entry.message === "provider 调用重试") current.attempts += 1;
    if (entry.message === "调用成功") {
      current.status = "success";
      current.usage = entry.usage || null;
      current.errorCode = null;
    } else if (entry.message === "章节调用复用") {
      current.status = "success";
    } else if (entry.message === "使用本地兜底响应") {
      if (current.status !== "success") {
        current.status = "failed";
        current.errorCode = "LOCAL_FALLBACK";
      }
    } else if (entry.message === "provider 调用失败，尝试下一个") {
      current.attempts += current.attempts === 0 ? 1 : 0;
      if (current.status !== "success") {
        current.status = "failed";
        current.errorCode = entry.errorCode || "UPSTREAM_ERROR";
      }
    }
    executions.set(executionKey, current);
  }

  const calls = [...executions.values()];
  const usage = emptyUsage();
  let cacheEligiblePromptTokens = 0;
  for (const call of calls) {
    if (call.status !== "success" || !call.usage) continue;
    for (const field of ["promptTokens", "completionTokens", "reasoningTokens", "totalTokens"]) {
      usage[field] += Number(call.usage[field]) || 0;
    }
    const observed = call.usage.cacheObserved === true || call.usage.cacheHitRate !== null && call.usage.cacheHitRate !== undefined;
    if (observed) {
      usage.cacheObserved = true;
      usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + (Number(call.usage.cachedPromptTokens) || 0);
      cacheEligiblePromptTokens += Number(call.usage.promptTokens) || 0;
    }
  }
  usage.cacheHitRate = usage.cacheObserved && cacheEligiblePromptTokens > 0
    ? usage.cachedPromptTokens / cacheEligiblePromptTokens
    : null;

  return {
    reportId,
    status: calls.length === 0 ? "not_found"
      : calls.every((call) => call.status === "success") ? "success"
        : calls.some((call) => call.status === "success") ? "partial_success" : "failed",
    calls: calls.length,
    succeeded: calls.filter((call) => call.status === "success").length,
    failed: calls.filter((call) => call.status === "failed").length,
    incomplete: calls.filter((call) => call.status === "incomplete").length,
    usage,
    sections: calls
  };
}
