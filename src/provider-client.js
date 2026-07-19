import fetch from "node-fetch";
import { getProviderConfig, resolveProviderOutputTokens } from "./config.js";
import { publicError, RouterError } from "./errors.js";
import { log, LogLevel } from "./logger.js";

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const PROVIDER_MAX_ATTEMPTS = 3;

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

export async function readBoundedResponse(response, maximum) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new RouterError(`上游响应超过 ${maximum} 字节`, { code: "UPSTREAM_RESPONSE_TOO_LARGE", status: 502 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) {
      response.body.destroy?.();
      throw new RouterError(`上游响应超过 ${maximum} 字节`, { code: "UPSTREAM_RESPONSE_TOO_LARGE", status: 502 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function shouldRetryProviderError(error, signal) {
  return !signal?.aborted && publicError(error).retryable === true;
}

export async function executeWithRetry(operation, {
  maxAttempts = PROVIDER_MAX_ATTEMPTS,
  signal,
  delay = abortableDelay,
  backoffMs = (failedAttempt) => 1000 * failedAttempt,
  onRetry
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetryProviderError(error, signal)) throw error;
      const waitMs = backoffMs(attempt);
      onRetry?.({ error, failedAttempt: attempt, nextAttempt: attempt + 1, waitMs });
      await delay(waitMs, signal);
    }
  }
}

async function fetchWithRetry(url, options, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  return executeWithRetry(async () => {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 30000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const rawText = await readBoundedResponse(response, maxResponseBytes);
      let data = {};
      try { data = rawText ? JSON.parse(rawText) : {}; } catch { data = { rawText }; }
      if (!response.ok) {
        const error = new Error(data?.error?.message || data?.message || data?.rawText || `HTTP ${response.status}`);
        error.status = response.status;
        error.upstream = data;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }, {
    signal: options.signal,
    onRetry: options.onRetry
  });
}

function truncatePrompt(prompt, maxLength) {
  return prompt.length <= maxLength ? prompt : `${prompt.slice(0, maxLength)}\n...[内容已截断]`;
}

function buildSystemPrompt(mode, providerLabel) {
  const modeHints = { compact: "默认优先压缩输出，只保留用户真正需要的内容。", normal: "保持简洁、完整。", detailed: "在不啰嗦的前提下提供较完整说明。" };
  return [
    "你是一个通过 MCP 被调用的外部模型，供 Codex 转发用户请求。",
    "请直接给出最终答案，不要解释内部推理过程、加前言或重复用户问题。",
    "如果用户要求代码、列表或步骤，直接给出可用结果。",
    "尽量短，但不要牺牲正确性。",
    `当前 provider: ${providerLabel}.`,
    `输出模式: ${mode}. ${modeHints[mode] || modeHints.compact}`
  ].join("\n");
}

function resolveMaxOutputTokens(config, mode, requested) {
  return resolveProviderOutputTokens(config.id, mode, requested);
}

function getContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || "").join("");
  return "";
}

export function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const cacheObserved = usage.prompt_tokens_details?.cached_tokens !== undefined
    || usage.cache_read_input_tokens !== undefined
    || usage.cached_tokens !== undefined;
  const cachedPromptTokens = cacheObserved
    ? Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0) || 0
    : null;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const reasoningTokens = Number(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0
  ) || 0;
  return {
    promptTokens,
    cachedPromptTokens,
    cacheObserved,
    completionTokens,
    reasoningTokens,
    totalTokens: Number(usage.total_tokens ?? (promptTokens + completionTokens)) || 0,
    cacheHitRate: cacheObserved && promptTokens > 0 ? cachedPromptTokens / promptTokens : null
  };
}

export function buildProviderRequestBody(config, prompt, mode, outputTokens, temperature) {
  const body = {
    model: config.model,
    messages: [{ role: "system", content: buildSystemPrompt(mode, config.label) }, { role: "user", content: truncatePrompt(prompt, config.contextChars) }],
    temperature,
    ...config.request.extraBody,
    [config.request.maxOutputTokensField]: outputTokens
  };
  for (const parameter of config.request.omitParameters) delete body[parameter];
  return body;
}

export async function callProvider(selected, prompt, mode, maxOutputTokens, temperature, requestId, callOptions = {}) {
  const config = getProviderConfig(selected);
  if (!config) throw new RouterError(`不支持的模型: ${selected}`, { code: "INVALID_PROVIDER", status: 400 });
  const apiKey = config.keyEnv.map((name) => process.env[name]).find(Boolean);
  if (!apiKey) throw new RouterError(`缺少环境变量: ${config.keyEnv.join(" / ")}`, { code: "CONFIG_ERROR", status: 500 });

  const outputTokens = resolveMaxOutputTokens(config, mode, maxOutputTokens);
  const body = buildProviderRequestBody(config, prompt, mode, outputTokens, temperature);
  const trace = {
    ...(callOptions.reportId ? { reportId: callOptions.reportId } : {}),
    ...(callOptions.sectionId ? { sectionId: callOptions.sectionId } : {}),
    ...(callOptions.stage ? { stage: callOptions.stage } : {}),
    ...(callOptions.idempotencyKey ? { idempotencyKey: callOptions.idempotencyKey } : {})
  };
  log(LogLevel.INFO, "调用模型", { requestId, ...trace, provider: selected, model: config.model, promptLen: prompt.length });
  const data = await fetchWithRetry(config.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...config.headers, [config.auth.header]: `${config.auth.prefix}${apiKey}` },
    body: JSON.stringify(body),
    timeout: Math.min(config.timeout, Math.max(1, (callOptions.deadlineAt || Infinity) - Date.now())),
    signal: callOptions.signal,
    onRetry: ({ error, failedAttempt, nextAttempt, waitMs }) => {
      const classified = publicError(error);
      log(LogLevel.WARN, "provider 调用重试", {
        requestId,
        ...trace,
        provider: selected,
        model: config.model,
        failedAttempt,
        nextAttempt,
        waitMs,
        errorCode: classified.code,
        retryable: classified.retryable
      });
    }
  });
  if (data.error) {
    const error = new Error(data.error.message || "upstream error");
    error.status = data.error.status || 500;
    error.upstream = data;
    throw error;
  }
  const result = getContent(data);
  if (!result) {
    const choice = data?.choices?.[0];
    const finishReason = choice?.finish_reason || "unknown";
    const usage = data?.usage || {};
    const error = new Error(
      `上游响应中没有可读取的文本内容 (finish_reason=${finishReason}, completion_tokens=${usage.completion_tokens ?? "unknown"})`
    );
    error.code = "EMPTY_RESPONSE";
    error.status = 502;
    error.upstream = {
      finish_reason: finishReason,
      usage,
      has_reasoning_content: Boolean(choice?.message?.reasoning_content)
    };
    throw error;
  }
  const usage = normalizeUsage(data.usage);
  log(LogLevel.INFO, "调用成功", { requestId, ...trace, provider: selected, resultLen: result.length, mode, outputTokens, usage });
  return { result, model: config.model, outputTokens, usage };
}

export function buildLocalFallbackResponse(prompt, errors = []) {
  if (/代码|实现|函数|组件|接口|优化|bug|报错|重构|设计|写法|code|implement/i.test(prompt)) {
    return "请提供具体问题或需求，我直接给代码。\n当前外部模型暂时不可用；可补充：现有代码、目标行为、技术栈。";
  }
  const messages = errors.map((error) => publicError(error).message).filter(Boolean).slice(0, 3);
  const reason = messages.length ? `上游模型暂时不可用（${messages.join(" / ")}）` : "上游模型暂时不可用";
  return `${reason}\n请把问题写具体一点，我就能直接给可执行方案。`;
}
