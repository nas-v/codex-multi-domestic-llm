import "dotenv/config";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getProviderConfig, listProviders } from "./config.js";
import { log, LogLevel } from "./logger.js";
import { routeModel } from "./router.js";
import { errorPayload, RouterError } from "./errors.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 10000;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES, bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS } = {}) {
  const chunks = [];
  let size = 0;
  const timeoutId = setTimeout(() => req.destroy(new RouterError("HTTP 请求体读取超时", {
    code: "REQUEST_TIMEOUT", status: 408, retryable: true
  })), bodyTimeoutMs);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) {
        throw new RouterError(`HTTP 请求体不能超过 ${maxBodyBytes} 字节`, {
          code: "PAYLOAD_TOO_LARGE", status: 413
        });
      }
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timeoutId);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new RouterError("请求体不是合法 JSON", { code: "INVALID_JSON", status: 400, cause });
  }
}

export function createHttpHandler({
  route = routeModel,
  idFactory = randomUUID,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS
} = {}) {
  return async (req, res) => {
    const requestId = idFactory();
    let requestedProvider = null;
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        const providers = listProviders().map((name) => {
          const config = getProviderConfig(name);
          return {
            name,
            model: config?.model,
            baseUrl: config?.baseUrl,
            envReady: Boolean(config?.keyEnv?.some((key) => Boolean(process.env[key]))),
            contextChars: config?.contextChars,
            defaultMaxOutputTokens: config?.defaultMaxOutputTokens
          };
        });

        return sendJson(res, 200, { ok: true, server: "smart-ask-router", providers });
      }

      if (req.method === "GET" && url.pathname === "/providers") {
        const providers = listProviders().map((name) => {
          const config = getProviderConfig(name);
          return { name, label: config?.label, model: config?.model };
        });
        return sendJson(res, 200, { providers });
      }

      if (req.method === "POST" && (url.pathname === "/smart_ask" || url.pathname === "/ask")) {
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (!contentType.startsWith("application/json")) {
          throw new RouterError("Content-Type 必须是 application/json", { code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
        }
        const body = await readJsonBody(req, { maxBodyBytes, bodyTimeoutMs });
        requestedProvider = body.provider || "auto";
        const controller = new AbortController();
        const abortRequest = () => controller.abort(Object.assign(new Error("HTTP 客户端已取消请求"), { name: "AbortError", code: "ABORT_ERR" }));
        req.once("aborted", abortRequest);
        let result;
        try {
          result = await route({
            prompt: body.prompt,
            provider: body.provider,
            mode: body.mode,
            maxOutputTokens: body.maxOutputTokens,
            temperature: body.temperature,
            reportId: body.reportId,
            sectionId: body.sectionId,
            stage: body.stage,
            requestId,
            signal: controller.signal
          });
        } finally {
          req.removeListener("aborted", abortRequest);
        }
        return sendJson(res, 200, {
          ...result,
          output_tokens: result.outputTokens,
          fallback: result.fallbackType === "local_fallback"
        });
      }

      return sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      const payload = errorPayload(err, {
        requestId,
        provider: requestedProvider || err?.provider
      });
      log(LogLevel.ERROR, "HTTP 请求失败", {
        provider: requestedProvider || err?.provider,
        requestId,
        model: err?.model,
        status: err?.status,
        error: err.message,
        upstream: err?.upstream
      });
      return sendJson(res, payload.error.status, payload);
    }
  };
}

export function createHttpServer(options) {
  return http.createServer(createHttpHandler(options));
}

export function classifyListenError(error) {
  if (error?.code === "EADDRINUSE") return { code: "PORT_IN_USE", message: "HTTP 端口已被占用" };
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return { code: "PORT_PERMISSION_DENIED", message: "没有权限监听 HTTP 端口" };
  }
  return { code: "HTTP_LISTEN_ERROR", message: "HTTP 服务监听失败" };
}

export function startHttpServer({
  port = Number(process.env.PORT || 8000),
  onFatal = (exitCode) => { process.exitCode = exitCode; },
  ...options
} = {}) {
  const server = createHttpServer(options);
  server.once("error", (error) => {
    const classified = classifyListenError(error);
    log(LogLevel.ERROR, classified.message, {
      errorCode: classified.code,
      code: error?.code,
      address: error?.address,
      port: error?.port ?? port
    });
    onFatal(1);
  });
  server.listen(port, () => {
    log(LogLevel.INFO, "HTTP 服务已启动", {
      port,
      endpoints: ["/health", "/providers", "/smart_ask", "/ask"]
    });
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) startHttpServer();
