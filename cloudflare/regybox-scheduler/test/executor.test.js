import assert from "node:assert/strict";
import test from "node:test";

import { executePlan, executionMode, readLastRun } from "../src/executor.js";
import { buildFailureFingerprint, errorPayload } from "../src/failures.js";
import { handleScheduled } from "../src/index.js";
import {
  ClassIsOverbookedError,
  RegyboxLoginError,
  RegyboxTimeoutError,
} from "../src/regybox.js";

const workerEnv = {
  PHPSESSID: "session",
  REGYBOX_USER: "user",
};

function makeKv(existing = new Map()) {
  const writes = [];
  return {
    writes,
    async get(key) {
      return existing.get(key) ?? null;
    },
    async put(key, value, options) {
      writes.push({ key, value, options });
      existing.set(key, value);
    },
    async list() {
      return { keys: [] };
    },
  };
}

function dispatch({ operation = "enroll", cacheKey = "regybox:v1:calendar:test", classType = "WOD" } = {}) {
  return {
    operation,
    inputs: {
      operation,
      "class-date": "2026-07-12",
      "class-time": "06:30",
      "class-type": classType,
      "calendar-event-name": "Crossfit",
      "cache-key": cacheKey,
      "calendar-fingerprint": "calendar-fingerprint",
    },
  };
}

function fakeClient() {
  return { bootstrapSession: async () => {} };
}

function stateWrites(kv) {
  return kv.writes.filter(({ key }) => key !== "regybox:v1:last_run");
}

test("execution mode keeps GitHub dispatch as the backward-compatible preference", () => {
  assert.equal(
    executionMode({
      ...workerEnv,
      GITHUB_TOKEN: "token",
      GITHUB_OWNER: "martim",
      GITHUB_REPO: "regybox",
    }),
    "dispatch",
  );
  assert.throws(
    () => executionMode({ GITHUB_TOKEN: "token" }),
    /GITHUB_OWNER, GITHUB_REPO, PHPSESSID, REGYBOX_USER/,
  );
});

test("worker execution writes the Action-compatible success and noop cache states", async () => {
  const kv = makeKv(
    new Map([["preserved", JSON.stringify({ failureNotificationFingerprint: "old-failure" })]]),
  );
  const results = [
    { status: "success", classType: "Resolved WOD" },
    { status: "success", classType: "Resolved WOD" },
    { status: "noop", classType: "Resolved WOD" },
    {
      status: "noop",
      classType: "Resolved WOD",
      cacheState: "not_open",
      enrollmentOpensAt: "2026-07-12T05:00:00+01:00",
      lastCheckedAt: "2026-07-12T04:00:00+01:00",
    },
  ];

  await executePlan({
    env: workerEnv,
    kv,
    dispatches: [
      dispatch({ cacheKey: "preserved" }),
      dispatch({ operation: "unenroll", cacheKey: "unenroll" }),
      dispatch({ cacheKey: "noop" }),
      dispatch({ cacheKey: "not-open" }),
    ],
    createClient: fakeClient,
    runOperationImpl: async () => results.shift(),
  });

  const writes = Object.fromEntries(stateWrites(kv).map(({ key, value }) => [key, JSON.parse(value)]));
  assert.equal(writes.preserved.state, "enrolled");
  assert.equal(writes.preserved.classType, "Resolved WOD");
  assert.equal(writes.preserved.failureNotificationFingerprint, "old-failure");
  assert.equal(writes.unenroll.state, "unenrolled");
  assert.equal(writes.noop.state, "enrolled");
  assert.deepEqual(writes["not-open"], {
    state: "not_open",
    classDate: "2026-07-12",
    classTime: "06:30",
    classType: "Resolved WOD",
    calendarEventName: "Crossfit",
    calendarFingerprint: "calendar-fingerprint",
    enrollmentOpensAt: "2026-07-12T05:00:00+01:00",
    lastCheckedAt: "2026-07-12T04:00:00+01:00",
  });
  assert.ok(stateWrites(kv).every(({ options }) => options.expirationTtl === 2592000));
});

test("not_open without an opening timer deliberately does not update cached state", async () => {
  const kv = makeKv();
  await executePlan({
    env: workerEnv,
    kv,
    dispatches: [dispatch()],
    createClient: fakeClient,
    runOperationImpl: async () => ({
      status: "noop",
      classType: "WOD",
      cacheState: "not_open",
      lastCheckedAt: "2026-07-12T04:00:00+01:00",
    }),
  });

  assert.deepEqual(stateWrites(kv), []);
  assert.equal((await readLastRun(kv)).operations[0].outcome, "noop");
});

test("one operation failure leaves state untouched and does not prevent later operations", async () => {
  const kv = makeKv();
  const failures = [];
  let calls = 0;
  await executePlan({
    env: workerEnv,
    kv,
    dispatches: [dispatch({ cacheKey: "failed" }), dispatch({ cacheKey: "later" })],
    createClient: fakeClient,
    runOperationImpl: async () => {
      calls += 1;
      if (calls === 1) {
        throw new RegyboxLoginError();
      }
      return { status: "success", classType: "WOD" };
    },
    onFailure: async (failure) => failures.push(failure),
  });

  assert.equal(calls, 2);
  assert.deepEqual(stateWrites(kv).map(({ key }) => key), ["later"]);
  assert.equal(failures[0].payload.errorCode, "login_error");
  assert.equal(failures[0].fingerprint, "failure:enroll:login_error:Unable to log in to Regybox");
  assert.deepEqual(
    (await readLastRun(kv)).operations.map(({ outcome, errorCode }) => [outcome, errorCode]),
    [["failure", "login_error"], ["success", undefined]],
  );
});

test("worker skips operations when the remaining invocation budget is below thirty seconds", async () => {
  const kv = makeKv();
  let clock = 0;
  let ran = false;
  await executePlan({
    env: workerEnv,
    kv,
    dispatches: [dispatch()],
    now: () => clock,
    createClient: () => ({
      bootstrapSession: async () => {
        clock = 13 * 60 * 1000 - 29_000;
      },
    }),
    runOperationImpl: async () => {
      ran = true;
      return { status: "success", classType: "WOD" };
    },
  });

  assert.equal(ran, false);
  assert.equal((await readLastRun(kv)).operations[0].outcome, "skipped");
});

test("dispatch mode and zero-operation runs both leave a last-run summary", async () => {
  const dispatchKv = makeKv();
  const dispatched = [];
  await executePlan({
    env: { ...workerEnv, GITHUB_TOKEN: "token", GITHUB_OWNER: "martim", GITHUB_REPO: "regybox" },
    kv: dispatchKv,
    dispatches: [dispatch()],
    dispatchWorkflowImpl: async (_env, item) => dispatched.push(item),
  });
  assert.equal(dispatched.length, 1);
  assert.deepEqual((await readLastRun(dispatchKv)).operations.map(({ outcome }) => outcome), ["dispatched"]);

  const zeroKv = makeKv();
  await executePlan({
    env: workerEnv,
    kv: zeroKv,
    dispatches: [],
    createClient: fakeClient,
  });
  const zeroSummary = await readLastRun(zeroKv);
  assert.equal(zeroSummary.mode, "worker");
  assert.equal(zeroSummary.plannedOperations, 0);
  assert.deepEqual(zeroSummary.operations, []);
  assert.equal(zeroKv.writes[0].options.expirationTtl, 604800);
});

test("calendar failures still write a failure last-run summary before rethrowing", async () => {
  const kv = makeKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    await assert.rejects(
      handleScheduled({
        ...workerEnv,
        GITHUB_TOKEN: "token",
        GITHUB_OWNER: "martim",
        GITHUB_REPO: "regybox",
        CALENDAR_URL: "https://calendar.example.test/classes.ics",
        REGYBOX_STATE: kv,
      }),
      /Calendar fetch failed: 503/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const summary = await readLastRun(kv);
  assert.equal(summary.mode, "dispatch");
  assert.deepEqual(summary.operations, [
    { operation: "calendar", outcome: "failure", errorCode: "calendar_or_plan_failure" },
  ]);
});

test("failure payloads and fingerprints mirror the action notification contract", () => {
  assert.equal(errorPayload(new RegyboxLoginError()).errorCode, "login_error");
  assert.equal(errorPayload(new RegyboxTimeoutError(30)).errorCode, "timeout_waiting_for_enrollment");
  assert.deepEqual(errorPayload(new RegyboxTimeoutError(30, { timeToEnroll: 60 })), {
    errorCode: "timeout_waiting_for_enrollment",
    userTitle: "Enrollment window opens later than expected",
    userMessage: "The class opens in 0:01:00, but the workflow is configured to wait only 30 seconds.",
    userNextSteps: [
      "Start the workflow closer to the opening time for enrollment.",
      "Increase timeout-seconds if your schedule requires a longer wait.",
      "Retry the workflow.",
    ],
    technicalMessage: "Enrollment opens in 60 seconds, which exceeds 30 seconds",
  });
  assert.equal(errorPayload(new ClassIsOverbookedError()).errorCode, "class_overbooked");
  const unknown = errorPayload(new Error("surprise"));
  assert.equal(unknown.errorCode, "unexpected_failure");
  assert.equal(unknown.technicalMessage, "surprise");
  assert.equal(
    buildFailureFingerprint({ operation: "unenroll", error: new ClassIsOverbookedError() }),
    "failure:unenroll:class_overbooked:Class and waitlist are full",
  );
});
