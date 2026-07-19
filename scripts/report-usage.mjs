import { readFileSync } from "node:fs";
import { aggregateReportUsage, parseLogLines } from "../src/report-usage.js";
import { LOG_FILE } from "../src/logger.js";

const reportId = process.argv[2];
if (!reportId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(reportId)) {
  console.error("用法: npm run report:usage -- <reportId>");
  process.exitCode = 2;
} else {
  let text = "";
  for (let index = 5; index >= 1; index -= 1) {
    try { text += readFileSync(`${LOG_FILE}.${index}`, "utf8"); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try { text += readFileSync(LOG_FILE, "utf8"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const { entries, invalidLines } = parseLogLines(text);
  console.log(JSON.stringify({ ...aggregateReportUsage(entries, reportId), invalidLogLines: invalidLines }, null, 2));
}
