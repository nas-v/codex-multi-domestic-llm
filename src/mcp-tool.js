import { randomUUID } from "node:crypto";
import { log, LogLevel } from "./logger.js";
import { errorPayload } from "./errors.js";
import { buildCallMetadata, routeModel } from "./router.js";

export const SMART_ASK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    requestId: { type: "string" },
    reportId: { type: "string" },
    sectionId: { type: "string" },
    stage: { type: "string", enum: ["plan", "section", "single"] },
    idempotencyKey: { type: "string" },
    idempotencyStatus: { type: "string", enum: ["executed", "joined", "reused"] },
    sourceRequestId: { type: "string" },
    requestedProvider: { type: "string" },
    selectedProvider: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    mode: { type: "string" },
    outputTokens: { type: "number" },
    attempts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          status: { type: "string", enum: ["success", "error"] },
          durationMs: { type: "number" },
          statusCode: { type: ["number", "null"] },
          errorCode: { type: "string" },
          retryable: { type: "boolean" },
          error: { type: "string" }
          , usage: { type: "object", additionalProperties: true }
          , idempotencyKey: { type: "string" }
          , idempotencyStatus: { type: "string", enum: ["executed", "joined", "reused", "failed"] }
        },
        required: ["provider", "model", "status", "durationMs"]
      }
    },
    fallbackType: { type: "string", enum: ["none", "provider_failover", "local_fallback"] },
    fallbackReason: { type: ["string", "null"] }
    , usage: {
      type: "object",
      properties: {
        promptTokens: { type: "number" },
        cachedPromptTokens: { type: ["number", "null"] },
        cacheObserved: { type: "boolean" },
        completionTokens: { type: "number" },
        reasoningTokens: { type: "number" },
        totalTokens: { type: "number" },
        cacheHitRate: { type: ["number", "null"] }
      },
      required: ["promptTokens", "cachedPromptTokens", "cacheObserved", "completionTokens", "reasoningTokens", "totalTokens", "cacheHitRate"],
      additionalProperties: false
    }
  },
  required: ["requestId", "requestedProvider", "selectedProvider", "provider", "model", "mode", "outputTokens", "usage", "attempts", "fallbackType", "fallbackReason"],
  additionalProperties: false
};

export function createSmartAskHandler({ route = routeModel, idFactory = randomUUID } = {}) {
  return async (args = {}, context = {}) => {
    const { prompt, provider = "auto", mode = "compact", maxOutputTokens, temperature = 0.7, reportId, sectionId, stage } = args;
    const requestId = idFactory();
    try {
      const output = await route({ prompt, provider, mode, maxOutputTokens, temperature, requestId, reportId, sectionId, stage, signal: context.signal });
      return {
        content: [{ type: "text", text: output.result }],
        structuredContent: buildCallMetadata(output)
      };
    } catch (error) {
      log(LogLevel.ERROR, "调用失败", {
        requestId,
        ...(reportId ? { reportId } : {}),
        ...(sectionId ? { sectionId } : {}),
        ...(stage ? { stage } : {}),
        provider,
        status: error?.status,
        error: error?.message,
        upstream: error?.upstream
      });
      const payload = errorPayload(error, { requestId, provider });
      return {
        isError: true,
        content: [{ type: "text", text: payload.error.message }],
        structuredContent: payload
      };
    }
  };
}
