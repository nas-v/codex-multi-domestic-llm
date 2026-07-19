import test from "node:test";
import assert from "node:assert/strict";
import { buildSectionExecutionIdentity, SectionExecutionStore } from "../src/section-execution.js";

function identity(overrides = {}) {
  return buildSectionExecutionIdentity({
    reportId: "report-1",
    sectionId: "intro",
    provider: "zhipu",
    model: "glm",
    prompt: "same prompt",
    mode: "normal",
    maxOutputTokens: 1000,
    temperature: 0.7,
    ...overrides
  });
}

test("section identity is stable and provider/model scoped", () => {
  assert.deepEqual(identity(), identity());
  assert.notEqual(identity().key, identity({ provider: "kimi" }).key);
  assert.equal(identity().key, identity({ prompt: "changed" }).key);
  assert.notEqual(identity().fingerprint, identity({ prompt: "changed" }).fingerprint);
});

test("concurrent and completed duplicate sections share one execution", async () => {
  const store = new SectionExecutionStore();
  const { key, fingerprint } = identity();
  let calls = 0;
  let release;
  const operation = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return { result: "ok" };
  };
  const first = store.execute({ key, fingerprint, requestId: "req-1", operation });
  const second = store.execute({ key, fingerprint, requestId: "req-2", operation });
  await new Promise((resolve) => setImmediate(resolve));
  release();

  assert.equal((await first).disposition, "executed");
  assert.equal((await second).disposition, "joined");
  assert.equal((await store.execute({ key, fingerprint, requestId: "req-3", operation })).disposition, "reused");
  assert.equal(calls, 1);
});

test("failed and abandoned sections can be resumed", async () => {
  const store = new SectionExecutionStore();
  const { key, fingerprint } = identity();
  let calls = 0;
  const operation = async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary");
    return { result: "recovered" };
  };
  await assert.rejects(store.execute({ key, fingerprint, requestId: "req-fail", operation }), /temporary/);
  const recovered = await store.execute({ key, fingerprint, requestId: "req-retry", operation });
  assert.equal(recovered.value.result, "recovered");
  assert.equal(calls, 2);

  const abandonedStore = new SectionExecutionStore();
  const controller = new AbortController();
  const pending = abandonedStore.execute({
    key,
    fingerprint,
    requestId: "req-aborted",
    signal: controller.signal,
    operation: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
  controller.abort(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  await assert.rejects(pending, /cancelled/);
  const resumed = await abandonedStore.execute({
    key,
    fingerprint,
    requestId: "req-resumed",
    operation: async () => ({ result: "resumed" })
  });
  assert.equal(resumed.value.result, "resumed");
});

test("same section key rejects changed request content", async () => {
  const store = new SectionExecutionStore();
  const first = identity();
  const changed = identity({ prompt: "changed" });
  await store.execute({
    ...first,
    requestId: "req-original",
    operation: async () => ({ result: "original" })
  });
  await assert.rejects(
    store.execute({ ...changed, requestId: "req-conflict", operation: async () => ({ result: "wrong" }) }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409 && error.retryable === false
  );
});

test("section store stays bounded when all tracked executions are pending", async () => {
  const store = new SectionExecutionStore({ maxEntries: 1 });
  let release;
  const firstIdentity = identity();
  const first = store.execute({
    ...firstIdentity,
    requestId: "req-pending",
    operation: async () => {
      await new Promise((resolve) => { release = resolve; });
      return { result: "first" };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondIdentity = identity({ sectionId: "second" });
  const second = await store.execute({
    ...secondIdentity,
    requestId: "req-untracked",
    operation: async () => ({ result: "second" })
  });
  assert.equal(second.value.result, "second");
  assert.equal(store.entries.size, 1);
  release();
  await first;
});
