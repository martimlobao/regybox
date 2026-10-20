import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import worker, { BookrCoordinator } from "../src/index.js";
import { executePlan } from "../src/executor.js";
import { notifyResult, prepareWaitlistNotification, retryPendingNotifications } from "../src/notify.js";
import { stripJsoncComments } from "../scripts/render-wrangler-config.mjs";

function storage(values = new Map()) {
  return {
    values,
    get: async (key) => values.get(key),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async (key) => values.delete(key),
    list: async ({ prefix }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
  };
}
const emailEnv = { BOOKING_PLATFORM: "bookr", BOOKR_AUTH_COOKIE: "private-cookie", EMAIL_USERNAME: "sender@example.test", EMAIL_PASSWORD: "private-password", EMAIL_TO: "owner@example.test" };
const dispatch = { operation: "enroll", inputs: { "class-date": "2026-12-01", "class-time": "06:30", "class-type": "WOD", "cache-key": "booking", "calendar-fingerprint": "private-fingerprint" } };
const result = { status: "success", userIsWaitlisted: true };
function request() { return new Request("https://coordinator.internal/run", { method: "POST", body: JSON.stringify({ scheduledAt: Date.now() }) }); }

test("overlapping Bookr runs perform one booking and send one confirmation", async () => {
  const store = storage();
  const kvValues = new Map();
  const kv = { get: async (key) => kvValues.get(key) ?? null, put: async (key, value) => { kvValues.set(key, value); } };
  const env = { ...emailEnv, REGYBOX_NOTIFICATIONS: store };
  const coordinator = new BookrCoordinator({ storage: store }, env);
  let enrolled = false;
  let posts = 0;
  let sends = 0;
  coordinator.run = async () => executePlan({
    env, kv, dispatches: [dispatch],
    createBookrClientImpl: () => ({
      bootstrapSession: async () => {},
      listClasses: async () => [{ name: "WOD", date: "2026-12-01", start: "06:30", isOpen: true, userIsEnrolled: enrolled, userIsWaitlisted: enrolled }],
      enroll: async () => { posts += 1; await Promise.resolve(); enrolled = true; return { userIsWaitlisted: true }; },
    }),
    notifyResultImpl: (args) => notifyResult({ ...args, send: async () => { sends += 1; } }),
  });
  await Promise.all([coordinator.fetch(request()), coordinator.fetch(request())]);
  assert.equal(posts, 1);
  assert.equal(sends, 1);
});

test("a failed coordinated invocation does not prevent later runs", async () => {
  const coordinator = new BookrCoordinator({ storage: storage() }, {});
  let calls = 0;
  coordinator.run = async () => { if (++calls === 1) throw new Error("run failed"); };
  await assert.rejects(coordinator.fetch(request()), /run failed/);
  assert.equal((await coordinator.fetch(request())).status, 200);
  assert.equal(calls, 2);
});

test("Bookr scheduled entry point requires and uses the shared coordinator", async () => {
  await assert.rejects(worker.scheduled({}, emailEnv, {}), /BOOKR_COORDINATOR/);
  let calls = 0;
  const env = { ...emailEnv, BOOKR_COORDINATOR: {
    idFromName: (name) => { assert.equal(name, "bookr-scheduler"); return "singleton"; },
    get: (id) => { assert.equal(id, "singleton"); return { fetch: async (_url, options) => { calls += 1; assert.equal(JSON.parse(options.body).scheduledAt, 123); return new Response("done"); } }; },
  } };
  await worker.scheduled({ scheduledTime: 123 }, env, {});
  assert.equal(calls, 1);
  const config = JSON.parse(stripJsoncComments(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")));
  assert.ok(config.durable_objects.bindings.some((binding) => binding.name === "BOOKR_COORDINATOR" && binding.class_name === "BookrCoordinator"));
  assert.ok(config.migrations.some((migration) => migration.new_sqlite_classes.includes("BookrCoordinator")));
});

test("failed waitlist email is retried independently of an enrolled cache and survives a restart", async () => {
  const store = storage();
  const env = { ...emailEnv, REGYBOX_NOTIFICATIONS: store };
  const trace = [];
  await notifyResult({ env, dispatch, result, send: async () => { throw new Error("SMTP unavailable"); }, onTrace: async (event) => trace.push(event) });
  assert.equal([...store.values.values()][0].state, "pending");
  assert.equal(trace.at(-1).data.notificationStatus, "pending");
  assert.doesNotMatch(JSON.stringify([...store.values]), /private-cookie|private-password|private-fingerprint/);
  let sends = 0;
  const restarted = { ...env, REGYBOX_NOTIFICATIONS: storage(store.values) };
  await retryPendingNotifications(restarted, { send: async () => { sends += 1; } });
  await retryPendingNotifications(restarted, { send: async () => { sends += 1; } });
  await notifyResult({ env: restarted, dispatch, result: { ...result, status: "noop" }, send: async () => { sends += 1; } });
  assert.equal(sends, 1);
  assert.equal([...store.values.values()][0].state, "sent");
});

test("native email sends waitlist content from the durable outbox after a failed attempt", async () => {
  const store = storage();
  const messages = [];
  let attempts = 0;
  const env = {
    ...emailEnv,
    EMAIL_PROVIDER: "cloudflare",
    EMAIL_FROM: "bookings@example.test",
    EMAIL_TO: "owner@example.test",
    REGYBOX_NOTIFICATIONS: store,
    EMAIL_SENDER: { send: async (message) => {
      attempts += 1;
      if (attempts === 1) throw new Error("native email unavailable");
      messages.push(message);
    } },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await notifyResult({ env, dispatch, result });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal([...store.values.values()][0].state, "pending");
  await retryPendingNotifications({ ...env, REGYBOX_NOTIFICATIONS: storage(store.values) });
  await retryPendingNotifications(env);
  assert.equal(attempts, 2);
  assert.equal([...store.values.values()][0].state, "sent");
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].from, {
    name: "Bookr.fit Auto-enroll", email: "bookings@example.test",
  });
  assert.equal(messages[0].to, "owner@example.test");
  assert.match(messages[0].subject, /waitlisted/);
  assert.match(messages[0].text, /place in the class is not confirmed/);
});

test("a queued waitlist notice survives interruption before sending", async () => {
  const store = storage();
  const env = { ...emailEnv, REGYBOX_NOTIFICATIONS: store };
  await prepareWaitlistNotification({ env, dispatch, result });
  let sends = 0;
  await retryPendingNotifications(env, { send: async () => { sends += 1; } });
  assert.equal(sends, 1);
});

test("booking cache failures do not prevent waitlist delivery, and recovery does not duplicate it", async () => {
  const store = storage();
  const env = { ...emailEnv, REGYBOX_NOTIFICATIONS: store };
  let failCache = true;
  let sends = 0;
  const trace = [];
  const kv = { get: async () => null, put: async (key) => { if (key === "booking" && failCache) throw new Error("booking cache failed"); } };
  const options = {
    env, kv, dispatches: [dispatch], createBookrClientImpl: () => ({ bootstrapSession: async () => {} }),
    recorder: { trace: async (event) => trace.push(event) },
    notifyResultImpl: (args) => notifyResult({ ...args, send: async () => { sends += 1; } }),
  };
  await assert.rejects(executePlan({ ...options, runBookrOperationImpl: async () => result }), /booking cache failed/);
  assert.equal(sends, 1);
  assert.ok(trace.some((event) => event.code === "cache_write_failed"));
  failCache = false;
  await executePlan({ ...options, runBookrOperationImpl: async () => ({ ...result, status: "noop" }) });
  assert.equal(sends, 1);
});

test("failure to persist notification intent leaves the booking eligible for recovery", async () => {
  const store = storage();
  let broken = true;
  const originalPut = store.put;
  store.put = async (...args) => { if (broken) throw new Error("outbox unavailable"); return originalPut(...args); };
  const env = { ...emailEnv, REGYBOX_NOTIFICATIONS: store };
  let bookingWrites = 0;
  let sends = 0;
  const options = {
    env, kv: { get: async () => null, put: async (key) => { if (key === "booking") bookingWrites += 1; } }, dispatches: [dispatch],
    createBookrClientImpl: () => ({ bootstrapSession: async () => {} }),
    notifyResultImpl: (args) => notifyResult({ ...args, send: async () => { sends += 1; } }),
  };
  await assert.rejects(executePlan({ ...options, runBookrOperationImpl: async () => result }), /outbox unavailable/);
  assert.equal(bookingWrites, 0);
  broken = false;
  await executePlan({ ...options, runBookrOperationImpl: async () => ({ ...result, status: "noop" }) });
  assert.equal(bookingWrites, 1);
  assert.equal(sends, 1);
});
