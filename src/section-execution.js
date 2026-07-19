import { createHash } from "node:crypto";
import { RouterError } from "./errors.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 128;

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildSectionExecutionIdentity({
  reportId,
  sectionId,
  provider,
  model,
  prompt,
  mode,
  maxOutputTokens,
  temperature
}) {
  const identity = { reportId, sectionId, provider, model };
  return {
    key: `section:${stableHash(identity).slice(0, 24)}`,
    fingerprint: stableHash({ ...identity, prompt, mode, maxOutputTokens: maxOutputTokens ?? null, temperature })
  };
}

function abortError(signal) {
  return signal?.reason || Object.assign(new Error("请求已取消"), { name: "AbortError", code: "ABORT_ERR" });
}

export class SectionExecutionStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.state === "success" && now - entry.completedAt >= this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const completed = [...this.entries].find(([, entry]) => entry.state === "success");
      if (!completed) break;
      this.entries.delete(completed[0]);
    }
  }

  async consume(entry, signal, disposition) {
    if (signal?.aborted) throw abortError(signal);
    entry.consumers += 1;
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(abortError(signal));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const value = signal ? await Promise.race([entry.promise, aborted]) : await entry.promise;
      return { value, disposition, sourceRequestId: entry.sourceRequestId };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      entry.consumers -= 1;
      if (entry.state === "pending" && entry.consumers === 0) {
        for (const [key, current] of this.entries) {
          if (current === entry) this.entries.delete(key);
        }
        entry.controller.abort(Object.assign(new Error("章节调用已无等待者"), { name: "AbortError", code: "ABORT_ERR" }));
      }
    }
  }

  async execute({ key, fingerprint, requestId, signal, operation }) {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RouterError("相同报告章节的请求内容发生变化；请使用新的 sectionId", {
          code: "IDEMPOTENCY_CONFLICT",
          status: 409,
          retryable: false
        });
      }
      if (existing.state === "success") {
        return { value: existing.value, disposition: "reused", sourceRequestId: existing.sourceRequestId };
      }
      return this.consume(existing, signal, "joined");
    }

    if (this.entries.size >= this.maxEntries) {
      if (signal?.aborted) throw abortError(signal);
      return {
        value: await operation({ signal }),
        disposition: "executed",
        sourceRequestId: requestId
      };
    }

    const controller = new AbortController();
    const entry = {
      state: "pending",
      fingerprint,
      sourceRequestId: requestId,
      controller,
      consumers: 0,
      promise: null
    };
    entry.promise = Promise.resolve()
      .then(() => operation({ signal: controller.signal }))
      .then((value) => {
        entry.state = "success";
        entry.value = value;
        entry.completedAt = this.now();
        return value;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    entry.promise.catch(() => {});
    this.entries.set(key, entry);
    return this.consume(entry, signal, "executed");
  }
}

export const sectionExecutionStore = new SectionExecutionStore();
