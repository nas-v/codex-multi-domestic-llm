import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    health: false,
    json: false,
    provider: "auto",
    mode: "compact",
    temperature: 0.2,
    maxOutputTokens: undefined,
    prompt: ""
  };

  for (let i = 2; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--health") {
      args.health = true;
      continue;
    }
    if (value === "--json") {
      args.json = true;
      continue;
    }
    if (value === "--provider" && argv[i + 1]) {
      args.provider = argv[++i];
      continue;
    }
    if (value === "--mode" && argv[i + 1]) {
      args.mode = argv[++i];
      continue;
    }
    if (value === "--temperature" && argv[i + 1]) {
      args.temperature = Number(argv[++i]);
      continue;
    }
    if (value === "--max-output-tokens" && argv[i + 1]) {
      args.maxOutputTokens = Number(argv[++i]);
      continue;
    }
    args.prompt = [args.prompt, value].filter(Boolean).join(" ");
  }

  return args;
}

const args = parseArgs(process.argv);
const prompt = args.prompt.trim() || "请用一句话解释什么是 MCP，并给一个适合新手的比喻。";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.js"],
  cwd: rootDir,
  env: childEnv,
  stderr: "pipe"
});

const client = new Client({ name: "smart-ask-demo", version: "2.0.0" });

await client.connect(transport);

if (args.health) {
  const health = await client.callTool({ name: "health_check", arguments: {} });
  console.log(health.content?.[0]?.text || "");
  await client.close();
  process.exit(0);
}

const result = await client.callTool({
  name: "smart_ask",
  arguments: {
    prompt,
    provider: args.provider,
    mode: args.mode,
    temperature: args.temperature,
    ...(Number.isFinite(args.maxOutputTokens) ? { maxOutputTokens: args.maxOutputTokens } : {})
  }
});

if (args.json) {
  console.log(JSON.stringify({
    result: result.content?.[0]?.text || "",
    metadata: result.structuredContent || null
  }, null, 2));
} else {
  console.log(result.content?.[0]?.text || "");
}

await client.close();
