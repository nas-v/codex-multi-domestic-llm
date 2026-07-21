import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHttpHandler } from "../src/http-server.js";
import { RouterError } from "../src/errors.js";

async function invoke(handler, { method = "GET", url = "/", body, rawBody, headers = {} } = {}) {
  const encoded = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const req = Readable.from(encoded === undefined ? [] : [Buffer.from(encoded)]);
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1", ...headers };
  const response = { statusCode: null, headers: null, body: null };
  const res = {
    writeHead(statusCode, responseHeaders) {
      response.statusCode = statusCode;
      response.headers = responseHeaders;
    },
    end(payload) {
      response.body = payload ? JSON.parse(payload) : null;
    }
  };
  await handler(req, res);
  return response;
}

test("HTTP health route runs without binding a port", async () => {
  const response = await invoke(createHttpHandler({ idFactory: () => "req-health" }), { url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.server, "smart-ask-router");
  assert.equal(response.body.apiVersion, "2.0.0");
  assert.ok(response.body.providers.some((provider) => provider.name === "zhipu"));
});

test("HTTP 2.0 ask exposes only the canonical metadata fields", async () => {
  const route = async ({ requestId, provider, mode, reportId, sectionId, stage }) => ({
    requestId,
    reportId,
    sectionId,
    stage,
    requestedProvider: provider || "auto",
    selectedProvider: "zhipu",
    provider: "zhipu",
    model: "glm-5.2",
    mode: mode || "compact",
    outputTokens: 768,
    attempts: [{ provider: "zhipu", model: "glm-5.2", status: "success", durationMs: 1 }],
    fallbackType: "none",
    fallbackReason: null,
    result: "ok"
  });
  const response = await invoke(createHttpHandler({ route, idFactory: () => "req-http" }), {
    method: "POST",
    url: "/ask",
    body: {
      prompt: "hello", provider: "zhipu", mode: "compact",
      reportId: "report-http", sectionId: "intro", stage: "section"
    },
    headers: { "content-type": "application/json" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.requestId, "req-http");
  assert.equal(response.body.selectedProvider, "zhipu");
  assert.equal(response.body.outputTokens, 768);
  assert.equal(Object.hasOwn(response.body, "output_tokens"), false);
  assert.equal(Object.hasOwn(response.body, "fallback"), false);
  assert.equal(response.body.reportId, "report-http");
  assert.equal(response.body.sectionId, "intro");
});

test("HTTP errors use the shared structured payload", async () => {
  const route = async () => {
    throw new RouterError("不支持的模型: unknown", { code: "INVALID_PROVIDER", status: 400 });
  };
  const response = await invoke(createHttpHandler({ route, idFactory: () => "req-http-error" }), {
    method: "POST",
    url: "/ask",
    body: { prompt: "hello", provider: "unknown" }
    , headers: { "content-type": "application/json" }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.requestId, "req-http-error");
  assert.equal(response.body.error.code, "INVALID_PROVIDER");
  assert.equal(response.body.error.provider, "unknown");
});

test("HTTP unknown routes return 404", async () => {
  const response = await invoke(createHttpHandler(), { url: "/missing" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "not_found");
});

test("HTTP rejects malformed JSON with a stable error", async () => {
  const response = await invoke(createHttpHandler({ idFactory: () => "req-json" }), {
    method: "POST", url: "/ask", rawBody: "{invalid", headers: { "content-type": "application/json" }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.code, "INVALID_JSON");
});

test("HTTP rejects request bodies over the configured limit", async () => {
  const response = await invoke(createHttpHandler({ idFactory: () => "req-large", maxBodyBytes: 16 }), {
    method: "POST", url: "/ask", body: { prompt: "x".repeat(32) }, headers: { "content-type": "application/json" }
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("HTTP rejects non-JSON content types", async () => {
  const response = await invoke(createHttpHandler({ idFactory: () => "req-media" }), {
    method: "POST", url: "/ask", rawBody: "prompt=hello", headers: { "content-type": "text/plain" }
  });
  assert.equal(response.statusCode, 415);
  assert.equal(response.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
});
