import { randomUUID } from "node:crypto";
import { getProviderCandidates, getProviderConfig } from "./config.js";
import { publicError, RouterError } from "./errors.js";
import { log, LogLevel } from "./logger.js";
import { buildLocalFallbackResponse, callProvider } from "./provider-client.js";
import { buildSectionExecutionIdentity, sectionExecutionStore } from "./section-execution.js";

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

export async function routeModel({
  prompt,
  provider = "auto",
  mode = "compact",
  maxOutputTokens,
  temperature = 0.7,
  signal,
  totalTimeoutMs = 55000,
  reportId,
  sectionId,
  stage,
  requestId = randomUUID(),
  invokeProvider = callProvider,
  executionStore = sectionExecutionStore
}) {
  const trace = {
    ...(reportId ? { reportId } : {}),
    ...(sectionId ? { sectionId } : {}),
    ...(stage ? { stage } : {})
  };
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new RouterError("prompt 不能为空", { code: "INVALID_INPUT", status: 400 });
  }
  if (provider !== "auto" && !getProviderConfig(provider)) {
    throw new RouterError(`不支持的模型: ${provider}`, { code: "INVALID_PROVIDER", status: 400 });
  }
  if (!["compact", "normal", "detailed"].includes(mode)) {
    throw new RouterError("mode 必须是 compact、normal 或 detailed", { code: "INVALID_PARAMETER", status: 400 });
  }
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new RouterError("temperature 必须是 0 到 2 之间的有限数字", { code: "INVALID_PARAMETER", status: 400 });
  }
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)) {
    throw new RouterError("maxOutputTokens 必须是正整数", { code: "INVALID_PARAMETER", status: 400 });
  }
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new RouterError("totalTimeoutMs 必须是正数", { code: "INVALID_PARAMETER", status: 400 });
  }
  const traceFields = { reportId, sectionId };
  for (const [name, value] of Object.entries(traceFields)) {
    if (value !== undefined && (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value))) {
      throw new RouterError(`${name} 格式无效`, { code: "INVALID_PARAMETER", status: 400 });
    }
  }
  if (stage !== undefined && !["plan", "section", "single"].includes(stage)) {
    throw new RouterError("stage 必须是 plan、section 或 single", { code: "INVALID_PARAMETER", status: 400 });
  }
  if (sectionId && !reportId) {
    throw new RouterError("章节调用必须提供 reportId", { code: "INVALID_PARAMETER", status: 400 });
  }
  if (stage === "section" && (!reportId || !sectionId)) {
    throw new RouterError("章节调用必须同时提供 reportId 和 sectionId", { code: "INVALID_PARAMETER", status: 400 });
  }

  const controller = new AbortController();
  const abortError = (message) => Object.assign(new Error(message), { name: "AbortError", code: "ABORT_ERR" });
  const abortFromCaller = () => controller.abort(signal?.reason || abortError("请求已取消"));
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const deadlineAt = Date.now() + totalTimeoutMs;
  const deadlineId = setTimeout(() => controller.abort(abortError("请求总截止时间已到")), totalTimeoutMs);

  const candidates = getProviderCandidates(provider, prompt);
  const attempts = [];
  const errors = [];
  let result = null;
  let selectedProvider = null;
  let model = null;
  let outputTokens = 0;
  let usage = emptyUsage();
  let idempotencyKey = null;
  let idempotencyStatus = null;
  let sourceRequestId = null;

  try {
    for (const candidate of candidates) {
      if (controller.signal.aborted) break;
      const config = getProviderConfig(candidate);
      if (!config) continue;
      const startedAt = Date.now();
      const identity = stage === "section"
        ? buildSectionExecutionIdentity({
          reportId,
          sectionId,
          provider: candidate,
          model: config.model,
          prompt,
          mode,
          maxOutputTokens,
          temperature
        })
        : null;
      try {
        const invoke = ({ signal: invocationSignal }) => invokeProvider(
          candidate,
          prompt,
          mode,
          maxOutputTokens,
          temperature,
          requestId,
          {
            signal: invocationSignal,
            deadlineAt,
            reportId,
            sectionId,
            stage,
            idempotencyKey: identity?.key
          }
        );
        const execution = identity
          ? await executionStore.execute({
            key: identity.key,
            fingerprint: identity.fingerprint,
            requestId,
            signal: controller.signal,
            operation: invoke
          })
          : { value: await invoke({ signal: controller.signal }), disposition: "executed", sourceRequestId: requestId };
        const output = execution.value;
        result = output.result;
        selectedProvider = candidate;
        model = output.model || config.model;
        outputTokens = output.outputTokens || 0;
        idempotencyKey = identity?.key || null;
        idempotencyStatus = identity ? execution.disposition : null;
        sourceRequestId = identity ? execution.sourceRequestId : null;
        const attemptUsage = execution.disposition === "executed" ? output.usage || {} : {};
        for (const field of ["promptTokens", "completionTokens", "reasoningTokens", "totalTokens"]) {
          usage[field] += Number(attemptUsage[field]) || 0;
        }
        const cacheObserved = attemptUsage.cacheObserved === true || attemptUsage.cacheHitRate !== null && attemptUsage.cacheHitRate !== undefined;
        if (cacheObserved) {
          usage.cacheObserved = true;
          usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + (Number(attemptUsage.cachedPromptTokens) || 0);
        }
        usage.cacheHitRate = usage.cacheObserved && usage.promptTokens > 0 ? usage.cachedPromptTokens / usage.promptTokens : null;
        attempts.push({
          provider: candidate,
          model,
          status: "success",
          durationMs: Date.now() - startedAt,
          ...(identity ? { idempotencyKey: identity.key, idempotencyStatus: execution.disposition } : {}),
          ...(execution.disposition === "executed" && output.usage ? { usage: output.usage } : {})
        });
        if (identity && execution.disposition !== "executed") {
          log(LogLevel.INFO, "章节调用复用", {
            requestId,
            ...trace,
            provider: candidate,
            model,
            idempotencyKey: identity.key,
            idempotencyStatus: execution.disposition,
            sourceRequestId: execution.sourceRequestId
          });
        }
        break;
      } catch (error) {
        if (error?.code === "IDEMPOTENCY_CONFLICT") throw error;
        errors.push(error);
        const classified = publicError(error);
        attempts.push({
          provider: candidate,
          model: config.model,
          status: "error",
          durationMs: Date.now() - startedAt,
          ...(identity ? { idempotencyKey: identity.key, idempotencyStatus: "failed" } : {}),
          statusCode: classified.status,
          errorCode: classified.code,
          retryable: classified.retryable,
          error: classified.message
        });
        log(LogLevel.WARN, "provider 调用失败，尝试下一个", {
          requestId,
          ...trace,
          ...(identity ? { idempotencyKey: identity.key } : {}),
          provider: candidate,
          model: config.model,
          status: error?.status,
          errorCode: classified.code,
          retryable: classified.retryable,
          error: error?.message,
          upstream: error?.upstream
        });
        if (controller.signal.aborted) break;
      }
    }
  } finally {
    clearTimeout(deadlineId);
    signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!result) {
    result = buildLocalFallbackResponse(prompt, errors);
    selectedProvider = "local";
    model = "fallback";
    log(LogLevel.WARN, "使用本地兜底响应", { requestId, ...trace, errorCount: errors.length });
  }

  const successfulAttempt = attempts.find((attempt) => attempt.status === "success");
  const fallbackType = selectedProvider === "local"
    ? "local_fallback"
    : successfulAttempt && attempts[0]?.provider !== selectedProvider
      ? "provider_failover"
      : "none";

  return {
    requestId,
    ...trace,
    ...(idempotencyKey ? { idempotencyKey, idempotencyStatus, sourceRequestId } : {}),
    requestedProvider: provider,
    selectedProvider,
    provider: selectedProvider,
    model,
    mode,
    outputTokens,
    usage,
    attempts,
    fallbackType,
    fallbackReason: fallbackType === "none"
      ? null
      : fallbackType === "local_fallback"
        ? "all_providers_failed"
        : "preferred_provider_failed",
    result
  };
}

export function buildCallMetadata(output) {
  return {
    requestId: output.requestId,
    ...(output.reportId ? { reportId: output.reportId } : {}),
    ...(output.sectionId ? { sectionId: output.sectionId } : {}),
    ...(output.stage ? { stage: output.stage } : {}),
    ...(output.idempotencyKey ? {
      idempotencyKey: output.idempotencyKey,
      idempotencyStatus: output.idempotencyStatus,
      sourceRequestId: output.sourceRequestId
    } : {}),
    requestedProvider: output.requestedProvider,
    selectedProvider: output.selectedProvider,
    provider: output.provider,
    model: output.model,
    mode: output.mode,
    outputTokens: output.outputTokens,
    usage: output.usage,
    attempts: output.attempts,
    fallbackType: output.fallbackType,
    fallbackReason: output.fallbackReason
  };
}
