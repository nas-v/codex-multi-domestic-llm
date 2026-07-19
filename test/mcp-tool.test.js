import test from "node:test";
import assert from "node:assert/strict";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { RouterError } from "../src/errors.js";
import { createSmartAskHandler, SMART_ASK_OUTPUT_SCHEMA } from "../src/mcp-tool.js";

test("MCP smart_ask result matches SDK and declared output schemas", async () => {
  const route = async ({ requestId, provider, mode, reportId, sectionId, stage }) => ({
    requestId,
    reportId,
    sectionId,
    stage,
    requestedProvider: provider,
    selectedProvider: "zhipu",
    provider: "zhipu",
    model: "glm-5.2",
    mode,
    outputTokens: 768,
    usage: { promptTokens: 100, cachedPromptTokens: 80, cacheObserved: true, completionTokens: 20, reasoningTokens: 5, totalTokens: 120, cacheHitRate: 0.8 },
    attempts: [{ provider: "zhipu", model: "glm-5.2", status: "success", durationMs: 2 }],
    fallbackType: "none",
    fallbackReason: null,
    result: "ok"
  });
  const handler = createSmartAskHandler({ route, idFactory: () => "req-mcp" });
  const result = await handler({
    prompt: "hello", provider: "zhipu", mode: "compact",
    reportId: "report-1", sectionId: "section-1", stage: "section"
  });

  assert.equal(CallToolResultSchema.safeParse(result).success, true);
  const validate = new AjvJsonSchemaValidator().getValidator(SMART_ASK_OUTPUT_SCHEMA);
  assert.equal(validate(result.structuredContent).valid, true);
  assert.equal(result.content[0].text, "ok");
  assert.equal(result.structuredContent.requestId, "req-mcp");
  assert.equal(result.structuredContent.reportId, "report-1");
  assert.equal(result.structuredContent.sectionId, "section-1");
});

test("MCP smart_ask returns machine-readable errors", async () => {
  const route = async () => {
    throw new RouterError("prompt 不能为空", { code: "INVALID_INPUT", status: 400 });
  };
  const handler = createSmartAskHandler({ route, idFactory: () => "req-mcp-error" });
  const result = await handler({ prompt: "" });

  assert.equal(CallToolResultSchema.safeParse(result).success, true);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.requestId, "req-mcp-error");
  assert.equal(result.structuredContent.error.code, "INVALID_INPUT");
});
