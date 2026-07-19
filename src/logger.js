import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || ".", ".codex", "llm-mcp.log");
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_BACKUPS = 5;
const SENSITIVE_KEY = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie/i;
const MAX_STRING_LENGTH = 4000;

function redactString(value) {
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  return redacted.length <= MAX_STRING_LENGTH ? redacted : `${redacted.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`;
}

export function sanitizeLogValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (depth >= 8) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, seen, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeLogValue(item, seen, depth + 1);
  }
  return output;
}

export function createLogger({
  filePath = DEFAULT_LOG_FILE,
  maxBytes = Number(process.env.LLM_MCP_LOG_MAX_BYTES) || DEFAULT_MAX_BYTES,
  backups = Number(process.env.LLM_MCP_LOG_BACKUPS) || DEFAULT_BACKUPS,
  fsImpl = fs,
  stderr = console.error
} = {}) {
  let fileWarningEmitted = false;
  const logDir = path.dirname(filePath);
  try {
    if (!fsImpl.existsSync(logDir)) fsImpl.mkdirSync(logDir, { recursive: true });
  } catch {
    fileWarningEmitted = true;
    stderr("WARN", "日志目录不可写，降级为 stderr");
  }

  function rotateIfNeeded(incomingBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isInteger(backups) || backups < 1) return;
    let currentSize = 0;
    try {
      currentSize = fsImpl.statSync(filePath).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (currentSize + incomingBytes <= maxBytes) return;

    const oldest = `${filePath}.${backups}`;
    try { fsImpl.unlinkSync(oldest); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    for (let index = backups - 1; index >= 1; index -= 1) {
      try { fsImpl.renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    try { fsImpl.renameSync(filePath, `${filePath}.1`); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return function writeLog(level, message, meta = {}) {
    const safeMessage = redactString(String(message));
    const safeMeta = sanitizeLogValue(meta);
    const entry = `${JSON.stringify({ timestamp: new Date().toISOString(), level, message: safeMessage, ...safeMeta })}\n`;
    try {
      rotateIfNeeded(Buffer.byteLength(entry));
      fsImpl.appendFileSync(filePath, entry);
    } catch (error) {
      if (!fileWarningEmitted) {
        fileWarningEmitted = true;
        stderr("WARN", "日志文件写入失败，降级为 stderr", { code: error?.code });
      }
    }

    const colors = { INFO: "\x1b[32m", WARN: "\x1b[33m", ERROR: "\x1b[31m", DEBUG: "\x1b[36m" };
    stderr(`${colors[level] || ""}${level}\x1b[0m`, safeMessage, safeMeta);
  };
}

export const log = createLogger();
export const LogLevel = { INFO: "INFO", WARN: "WARN", ERROR: "ERROR", DEBUG: "DEBUG" };
export const LOG_FILE = DEFAULT_LOG_FILE;
