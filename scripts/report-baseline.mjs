import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBaselineArgs, runReportBaseline } from "../src/report-baseline.js";
import { routeModel } from "../src/router.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const options = parseBaselineArgs(process.argv.slice(2));
  const samplePath = resolve(root, options.sample || "baselines/samples/router-report-v1.json");
  const sample = JSON.parse(readFileSync(samplePath, "utf8"));
  const summary = await runReportBaseline({
    sample,
    provider: options.provider || "auto",
    live: options.live,
    route: routeModel,
    reportId: options.report_id
  });
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolve(root, options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, { mode: 0o600 });
    console.error(`基线摘要已保存: ${outputPath}`);
  }
  process.stdout.write(serialized);
  if (options.live && summary.status !== "success") process.exitCode = 1;
} catch (error) {
  console.error(`基线执行失败: ${error.message}`);
  process.exitCode = 2;
}
