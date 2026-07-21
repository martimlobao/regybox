import assert from "node:assert/strict";
import test from "node:test";

import { executePlan, executionMode, readActivity, readLastRun } from "../src/executor.js";
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
  return kv.writes.filter(({ key }) => !["regybox:v1:last_run", "regybox:v1:activity"].includes(key));
}

function activityWrites(kv) {
  return kv.writes.filter(({ key }) => key === "regybox:v1:activity");
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
  assert.equal(writes.preserved.classType, "WOD");
  // Recovery clears the stored failure fingerprint (parity with
  // cloudflare_kv.py) so a later recurrence of the same failure notifies again.
  assert.equal(writes.preserved.failureNotificationFingerprint, undefined);
  assert.equal(writes.unenroll.state, "unenrolled");
  assert.equal(writes.noop.state, "enrolled");
  assert.deepEqual(writes["not-open"], {
    state: "not_open",
    classDate: "2026-07-12",
    classTime: "06:30",
    classType: "WOD",
    calendarEventName: "Crossfit",
    calendarFingerprint: "calendar-fingerprint",
    enrollmentOpensAt: "2026-07-12T05:00:00+01:00",
    lastCheckedAt: "2026-07-12T04:00:00+01:00",
  });
  assert.ok(stateWrites(kv).every(({ options }) => options.expirationTtl === 2592000));
});

test("worker cache state retains the dispatched fallback class type for slot matching", async () => {
  const kv = makeKv();
  const classType = "WOD, Weekend WOD";
  await executePlan({
    env: workerEnv,
    kv,
    dispatches: [dispatch({ classType })],
    createClient: fakeClient,
    runOperationImpl: async () => ({ status: "success", classType: "Weekend WOD" }),
  });

  const cached = JSON.parse(stateWrites(kv)[0].value);
  assert.equal(cached.classType, classType);
  const cachedSlotKey = `${cached.classDate}T${cached.classTime}:${cached.classType}`;
  const eventSlotKey = `2026-07-12T06:30:${classType}`;
  assert.equal(cachedSlotKey, eventSlotKey);
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

test("a due not-open cache cannot be poisoned by a multi-day opening jump", async () => {
  const cacheKey = "regybox:v1:calendar:test";
  const originalState = {
    state: "not_open",
    enrollmentOpensAt: "2026-07-19T17:29:59.000Z",
    lastCheckedAt: "2026-07-19T16:58:00.000Z",
  };
  const kv = makeKv(new Map([[cacheKey, JSON.stringify(originalState)]]));
  const failures = [];

  const summary = await executePlan({
    env: workerEnv,
    kv,
    dispatches: [dispatch({ cacheKey })],
    now: () => Date.parse("2026-07-19T17:30:01.000Z"),
    createClient: fakeClient,
    runOperationImpl: async () => ({
      status: "noop",
      classType: "WOD",
      cacheState: "not_open",
      enrollmentOpensAt: "2026-07-22T04:59:59.000Z",
      lastCheckedAt: "2026-07-19T17:30:01.000Z",
    }),
    onFailure: async (failure) => failures.push(failure),
  });

  assert.equal(summary.operations[0].outcome, "failure");
  assert.equal(summary.operations[0].errorCode, "unparseable_response");
  assert.equal(failures[0].error.name, "UnparseableError");
  assert.deepEqual(JSON.parse(await kv.get(cacheKey)), originalState);
  assert.equal(kv.writes.some(({ key }) => key === cacheKey), false);
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

test("bootstrap failure reports every planned operation, writes the summary, and rethrows", async () => {
  const kv = makeKv();
  const loginError = new RegyboxLoginError();
  const failures = [];
  const dispatches = [dispatch({ cacheKey: "first" }), dispatch({ operation: "unenroll", cacheKey: "second" })];

  await assert.rejects(
    executePlan({
      env: workerEnv,
      kv,
      dispatches,
      createClient: () => ({ bootstrapSession: async () => { throw loginError; } }),
      onFailure: async (failure) => failures.push(failure),
    }),
    (error) => error === loginError,
  );

  assert.equal(failures.length, dispatches.length);
  assert.deepEqual(
    failures.map(({ payload, fingerprint }) => [payload.errorCode, fingerprint]),
    [
      ["login_error", "failure:enroll:login_error:Unable to log in to Regybox"],
      ["login_error", "failure:unenroll:login_error:Unable to log in to Regybox"],
    ],
  );
  assert.deepEqual(
    (await readLastRun(kv)).operations.map(({ operation, outcome, errorCode }) => [operation, outcome, errorCode]),
    [
      ["enroll", "failure", "login_error"],
      ["unenroll", "failure", "login_error"],
    ],
  );
});

test("last-run write failure does not mask a dispatch failure or a successful run", async () => {
  const kv = makeKv();
  const put = kv.put;
  const lastRunError = new Error("last-run unavailable");
  kv.put = async (key, ...args) => {
    if (key === "regybox:v1:last_run") {
      throw lastRunError;
    }
    return put(key, ...args);
  };
  const dispatchError = new Error("operation failed");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await assert.rejects(
      executePlan({
        env: { ...workerEnv, GITHUB_TOKEN: "token", GITHUB_OWNER: "martim", GITHUB_REPO: "regybox" },
        kv,
        dispatches: [dispatch()],
        dispatchWorkflowImpl: async () => { throw dispatchError; },
      }),
      (error) => error === dispatchError,
    );
    const summary = await executePlan({
      env: { ...workerEnv, GITHUB_TOKEN: "token", GITHUB_OWNER: "martim", GITHUB_REPO: "regybox" },
      kv,
      dispatches: [dispatch({ cacheKey: "success" })],
      dispatchWorkflowImpl: async () => {},
    });
    assert.equal(summary.operations[0].outcome, "dispatched");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(([message, error]) => message === "regybox: last-run state write failed:" && error === lastRunError));
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
  assert.equal(activityWrites(zeroKv).length, 0);
});

test("activity feed batches every worker outcome and dispatched operations once per run", async () => {
  const kv = makeKv();
  let clock = 0;
  let calls = 0;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await executePlan({
      env: workerEnv,
      kv,
      dispatches: [dispatch(), dispatch(), dispatch(), dispatch()],
      now: () => clock,
      createClient: fakeClient,
      runOperationImpl: async () => {
        calls += 1;
        if (calls === 2) {
          throw new RegyboxLoginError();
        }
        if (calls === 3) {
          clock = 13 * 60 * 1000 - 29_000;
          return { status: "noop", cacheState: "not_open" };
        }
        return { status: "success" };
      },
      onFailure: async () => {},
    });
    await executePlan({
      env: { ...workerEnv, GITHUB_TOKEN: "token", GITHUB_OWNER: "martim", GITHUB_REPO: "regybox" },
      kv,
      dispatches: [dispatch({ operation: "unenroll" })],
      dispatchWorkflowImpl: async () => {},
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(activityWrites(kv).length, 2);
  assert.deepEqual((await readActivity(kv)).map(({ outcome }) => outcome), [
    "dispatched",
    "skipped",
    "noop",
    "failure",
    "success",
  ]);
  assert.equal(activityWrites(kv)[0].options.expirationTtl, 2592000);
});

test("activity feed keeps the newest fifty entries and tolerates corrupt history", async () => {
  const kv = makeKv(new Map([["regybox:v1:activity", "not JSON"]]));
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (let index = 0; index < 60; index += 1) {
      await executePlan({
        env: workerEnv,
        kv,
        dispatches: [dispatch({ classType: `WOD ${index}`, cacheKey: `class-${index}` })],
        now: () => index * 1_000,
        createClient: fakeClient,
        runOperationImpl: async () => ({ status: "success" }),
      });
    }
  } finally {
    console.log = originalLog;
  }
  const activity = await readActivity(kv);
  assert.equal(activity.length, 50);
  assert.equal(activity[0].classType, "WOD 59");
  assert.equal(activity.at(-1).classType, "WOD 10");
});

test("an activity feed write failure does not break a successful run", async () => {
  const kv = makeKv();
  const put = kv.put;
  const activityError = new Error("activity unavailable");
  kv.put = async (key, ...args) => {
    if (key === "regybox:v1:activity") {
      throw activityError;
    }
    return put(key, ...args);
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const summary = await executePlan({
      env: workerEnv,
      kv,
      dispatches: [dispatch()],
      createClient: fakeClient,
      runOperationImpl: async () => ({ status: "success" }),
    });
    assert.equal(summary.operations[0].outcome, "success");
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [["regybox: activity state write failed:", activityError]]);
});

test("operation logs record successful and failed outcomes at their respective levels", async () => {
  const kv = makeKv();
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args);
  console.error = (...args) => errors.push(args);
  try {
    await executePlan({
      env: workerEnv,
      kv,
      dispatches: [dispatch(), dispatch({ cacheKey: "failed" })],
      createClient: fakeClient,
      runOperationImpl: async () => {
        if (logs.some(([message]) => String(message).includes("-> success"))) {
          throw new RegyboxLoginError();
        }
        return { status: "success" };
      },
      onFailure: async () => {},
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(logs.some(([message]) => String(message).includes("-> success")));
  assert.ok(errors.some(([message]) => String(message).includes("-> failure")));
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
  const activity = await readActivity(kv);
  assert.equal(activity.length, 1);
  const { at, ...entry } = activity[0];
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.deepEqual(entry, {
    operation: "calendar",
    outcome: "failure",
    errorCode: "calendar_or_plan_failure",
  });
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
