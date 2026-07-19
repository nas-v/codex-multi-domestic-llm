import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, errorPayload, publicError, RouterError } from "../src/errors.js";

test("classifies common upstream HTTP errors", () => {
  assert.deepEqual(classifyError(Object.assign(new Error("unauthorized"), { status: 401 })), {
    code: "AUTH_FAILED", status: 401, retryable: false
  });
  assert.deepEqual(classifyError(Object.assign(new Error("balance"), { status: 402 })), {
    code: "QUOTA_EXCEEDED", status: 402, retryable: false
  });
  assert.deepEqual(classifyError(Object.assign(new Error("missing"), { status: 404 })), {
    code: "MODEL_NOT_FOUND", status: 404, retryable: false
  });
  assert.deepEqual(classifyError(Object.assign(new Error("limited"), { status: 429 })), {
    code: "RATE_LIMIT", status: 429, retryable: true
  });
});

test("classifies timeout, network and empty response errors", () => {
  assert.equal(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })).code, "TIMEOUT");
  assert.equal(classifyError(Object.assign(new Error("dns"), { code: "ENOTFOUND" })).code, "NETWORK_ERROR");
  assert.equal(classifyError(Object.assign(new Error("empty"), { code: "EMPTY_RESPONSE" })).code, "EMPTY_RESPONSE");
});

test("builds a stable public error payload", () => {
  const error = new RouterError("不支持的模型", { code: "INVALID_PROVIDER", status: 400 });
  assert.deepEqual(errorPayload(error, {
    requestId: "req-error",
    provider: "unknown",
    attemptedProviders: []
  }), {
    requestId: "req-error",
    error: {
      code: "INVALID_PROVIDER",
      message: "不支持的模型",
      status: 400,
      retryable: false,
      provider: "unknown",
      attemptedProviders: []
    }
  });
});

test("redacts and truncates upstream messages before exposing them", () => {
  const message = `Authorization: Bearer top.secret api_key=private ${"x".repeat(600)}`;
  const output = publicError(new Error(message));
  assert.doesNotMatch(output.message, /top\.secret|private/);
  assert.match(output.message, /\[REDACTED\]/);
  assert.ok(output.message.length < message.length);
  assert.match(output.message, /已截断/);
});
