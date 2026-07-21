// src/server.js
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getProviderConfig, listProviders } from "./config.js";
import { log, LogLevel } from "./logger.js";
import { createSmartAskHandler, SMART_ASK_OUTPUT_SCHEMA } from "./mcp-tool.js";

const server = new Server(
  { name: "domestic-multi-llm", version: "2.0.0" },
  { capabilities: { tools: {} } }
);
const smartAskHandler = createSmartAskHandler();

// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "health_check",
    description: "检查 MCP server 是否已连通，并返回当前 provider 配置状态",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }, {
    name: "smart_ask",
    description: "智能调用 OpenAI 兼容接口，支持自动选择、错误重试、日志记录",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "输入问题或开发需求" },
        provider: {
          type: "string",
          enum: [...listProviders(), "auto"],
          default: "auto",
          description: "指定 provider 或 auto 自动选择"
        },
        mode: {
          type: "string",
          enum: ["compact", "normal", "detailed"],
          default: "compact",
          description: "输出模式，默认压缩输出以减少 token"
        },
        maxOutputTokens: {
          type: "number",
          minimum: 1,
          maximum: 4096,
          description: "限制外部模型输出长度；不传则按 mode 取默认值"
        },
        temperature: { type: "number", default: 0.7, description: "创造性参数 0-1" }
        , reportId: { type: "string", pattern: "^[a-zA-Z0-9._:-]{1,128}$", description: "长报告各阶段共享的关联 ID" }
        , sectionId: { type: "string", pattern: "^[a-zA-Z0-9._:-]{1,128}$", description: "章节 ID；章节调用时与 reportId 一起传入" }
        , stage: { type: "string", enum: ["plan", "section", "single"], description: "调用在长报告工作流中的阶段" }
      },
      required: ["prompt"]
    },
    outputSchema: SMART_ASK_OUTPUT_SCHEMA
  }]
}));

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (req, context) => {
  if (req.params.name === "health_check") {
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

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          server: "multi_domestic_llm",
          providers
        }, null, 2)
      }]
    };
  }

  if (req.params.name !== "smart_ask") throw new Error("未知工具");

  return smartAskHandler(req.params.arguments ?? {}, context);
});

// 启动服务
const transport = new StdioServerTransport();
await server.connect(transport);
log(LogLevel.INFO, "MCP stdio 服务已启动；该前台进程会保持运行，供 Codex/MCP 客户端连接。日常使用已注册的 smart_ask 时通常不需要手动运行 npm start。");
