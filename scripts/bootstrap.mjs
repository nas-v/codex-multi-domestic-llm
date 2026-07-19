import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
    ...options
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.error("[bootstrap] 检查环境...");
if (!existsSync(resolve(rootDir, ".env")) && existsSync(resolve(rootDir, ".env.example"))) {
  copyFileSync(resolve(rootDir, ".env.example"), resolve(rootDir, ".env"));
  console.error("[bootstrap] 已生成 .env");
}

if (!existsSync(resolve(rootDir, "node_modules"))) {
  console.error("[bootstrap] 安装依赖...");
  run("npm", ["install"]);
}

console.error("[bootstrap] 启动 MCP server...");
run(process.execPath, ["src/server.js"]);
