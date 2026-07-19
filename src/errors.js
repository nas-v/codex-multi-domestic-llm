const STATUS_RULES = new Map([
  [400, { code: "INVALID_REQUEST", retryable: false }],
  [401, { code: "AUTH_FAILED", retryable: false }],
  [402, { code: "QUOTA_EXCEEDED", retryable: false }],
  [403, { code: "AUTH_FAILED", retryable: false }],
  [404, { code: "MODEL_NOT_FOUND", retryable: false }],
  [408, { code: "TIMEOUT", retryable: true }],
  [429, { code: "RATE_LIMIT", retryable: true }]
]);

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT"
]);

export class RouterError extends Error {
  constructor(message, { code = "UPSTREAM_ERROR", status = 500, retryable = false, cause, upstream } = {}) {
    super(message, { cause });
    this.name = "RouterError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.upstream = upstream;
  }
}

const PUBLIC_MESSAGE_LIMIT = 500;

export function sanitizePublicMessage(value, fallback = "上游模型调用失败") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const sanitized = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  return sanitized.length > PUBLIC_MESSAGE_LIMIT
    ? `${sanitized.slice(0, PUBLIC_MESSAGE_LIMIT)}...[已截断]`
    : sanitized;
}

export function classifyError(error) {
  if (error instanceof RouterError) {
    return { code: error.code, status: error.status, retryable: error.retryable };
  }

  if (error?.code === "EMPTY_RESPONSE" || /没有可读取的文本内容/.test(error?.message || "")) {
    return { code: "EMPTY_RESPONSE", status: 502, retryable: false };
  }

  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return { code: "TIMEOUT", status: 504, retryable: true };
  }

  if (NETWORK_CODES.has(error?.code) || /ENOTFOUND|ECONNREFUSED|ECONNRESET|network|socket/i.test(error?.message || "")) {
    return { code: "NETWORK_ERROR", status: 502, retryable: true };
  }

  const upstreamStatus = Number(error?.status);
  if (STATUS_RULES.has(upstreamStatus)) {
    return { ...STATUS_RULES.get(upstreamStatus), status: upstreamStatus };
  }
  if (upstreamStatus >= 500) return { code: "UPSTREAM_ERROR", status: 502, retryable: true };
  return { code: "UPSTREAM_ERROR", status: 502, retryable: false };
}

export function publicError(error, overrides = {}) {
  const classified = classifyError(error);
  return {
    code: overrides.code || classified.code,
    message: sanitizePublicMessage(overrides.message || error?.message),
    status: overrides.status || classified.status,
    retryable: overrides.retryable ?? classified.retryable
  };
}

export function errorPayload(error, { requestId, provider, attemptedProviders = [] } = {}) {
  const detail = publicError(error);
  return {
    requestId,
    error: {
      ...detail,
      provider: provider || null,
      attemptedProviders
    }
  };
}
