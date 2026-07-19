import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listProviderDefinitions } from "../src/config.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const START = "# >>> codex-model-manager >>>";
const END = "# <<< codex-model-manager <<<";

function parseArgs(argv) {
  const args = { command: "help", dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (["list", "install", "remove", "help"].includes(argv[i])) args.command = argv[i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--config") args.config = argv[++i];
    else throw new Error(`未知参数: ${argv[i]}`);
  }
  return args;
}

function providers() {
  return listProviderDefinitions().filter((item) => item.enabled !== false);
}

function stripManaged(text) {
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\n?${escaped(START)}[\\s\\S]*?${escaped(END)}\\n?`, "g"), "").trimEnd();
}

function block() {
  return `${START}
# Managed by codex-multi-domestic-llm. This only registers smart_ask; it never changes Codex's main model.
[mcp_servers.multi_domestic_llm]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(resolve(rootDir, "src/server.js"))}]
cwd = ${JSON.stringify(rootDir)}
startup_timeout_sec = 120
tool_timeout_sec = 90
${END}`;
}

const args = parseArgs(process.argv);
if (args.command === "help") {
  console.log("用法：npm run codex:list | npm run codex:install | npm run codex:remove");
} else if (args.command === "list") {
  for (const item of providers()) console.log(`${item.id}\t${item.name || item.id}\t${item.model}`);
} else {
  const configPath = resolve(args.config || resolve(homedir(), ".codex/config.toml"));
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const cleaned = stripManaged(current);
  const next = args.command === "install" ? `${cleaned}\n\n${block()}\n` : `${cleaned}\n`;
  if (args.dryRun) console.log(next);
  else {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, next, "utf8");
    console.log(args.command === "install" ? "已注册 smart_ask。完全重启 Codex 后生效。" : "已移除 smart_ask 注册。" );
  }
}
