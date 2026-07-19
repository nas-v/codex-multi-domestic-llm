import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, sanitizeLogValue } from "../src/logger.js";

test("logger recursively redacts sensitive keys and bearer tokens", () => {
  const circular = { authorization: "Bearer secret-token", nested: { apiKey: "abc", note: "password=hunter2" } };
  circular.self = circular;
  assert.deepEqual(sanitizeLogValue(circular), {
    authorization: "[REDACTED]",
    nested: { apiKey: "[REDACTED]", note: "password=[REDACTED]" },
    self: "[CIRCULAR]"
  });
});

test("logger rotates files without touching the real filesystem", () => {
  const files = new Map([["/logs/app.log", "old-data"]]);
  const fakeFs = {
    existsSync: () => true,
    mkdirSync: () => {},
    statSync(file) {
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { size: Buffer.byteLength(files.get(file)) };
    },
    appendFileSync(file, value) { files.set(file, `${files.get(file) || ""}${value}`); },
    unlinkSync(file) {
      if (!files.delete(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    renameSync(from, to) {
      if (!files.has(from)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.set(to, files.get(from));
      files.delete(from);
    }
  };
  const logger = createLogger({ filePath: "/logs/app.log", maxBytes: 20, backups: 2, fsImpl: fakeFs, stderr: () => {} });
  logger("INFO", "new-entry", {});
  assert.equal(files.get("/logs/app.log.1"), "old-data");
  assert.match(files.get("/logs/app.log"), /new-entry/);
});

test("logger emits one degradation warning when file writes fail", () => {
  const stderrCalls = [];
  const fakeFs = {
    existsSync: () => true,
    statSync: () => ({ size: 0 }),
    appendFileSync() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); }
  };
  const logger = createLogger({ filePath: "/logs/app.log", fsImpl: fakeFs, stderr: (...args) => stderrCalls.push(args) });
  logger("INFO", "one");
  logger("INFO", "two");
  assert.equal(stderrCalls.filter((call) => call[1] === "日志文件写入失败，降级为 stderr").length, 1);
});
