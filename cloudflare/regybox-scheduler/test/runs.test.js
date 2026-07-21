import assert from "node:assert/strict";
import test from "node:test";

import { executePlan } from "../src/executor.js";
import {
  createRunRecorder,
  outcomeStatus,
  readRun,
  readRuns,
  runConstants,
} from "../src/runs.js";
import {
  buildStatusModel,
  handleRunRequest,
  handleRunsRequest,
  renderRunPage,
  renderStatusPage,
} from "../src/status.js";
import worker, { handleScheduled } from "../src/index.js";

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
  };
}

test("run records start durably, sanitize traces, and finalize with retained summaries", async () => {
  const kv = makeKv();
  let clock = Date.parse("2026-07-20T10:00:00.000Z");
  const id = "0123456789abcdef0123456789abcdef0123";
  const originalLog = console.log;
  console.log = () => {};
  try {
    const recorder = await createRunRecorder({
      kv,
      mode: "worker",
      scheduledAt: clock - 1000,
      now: () => clock,
      id,
    });

    const running = await readRun(kv, id);
    assert.equal(running.status, "running");
    assert.deepEqual((await readRuns(kv)).map((run) => run.id), [id]);

    clock += 4000;
    await recorder.trace({
      level: "warn",
      scope: "poll",
      code: "timer_jump",
      message: "cookie=secret user@example.com https://regybox.pt/action.php?token=secret",
      data: {
        timerSeconds: 213598,
        endpointPath: "/action.php?token=secret",
        rawHtml: "<button>secret</button>",
        cacheKey: "user@example.com",
      },
    });
    clock += 1000;
    await recorder.finalize({
      operations: [{
        operation: "enroll",
        classDate: "2026-07-22",
        classTime: "06:30",
        classType: "WOD",
        outcome: "failure",
        errorCode: "timer_rollover",
        cacheKey: "secret@example.com",
      }],
    });
  } finally {
    console.log = originalLog;
  }

  const record = await readRun(kv, id);
  assert.equal(record.status, "failure");
  assert.equal(record.durationMs, 5000);
  assert.equal(record.trace.length, 1);
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes("user@example.com"));
  assert.ok(!serialized.includes("secret@example.com"));
  assert.ok(!serialized.includes("rawHtml"));
  assert.ok(!serialized.includes("cacheKey"));
  assert.ok(!serialized.includes("regybox.pt"));
  assert.equal(record.trace[0].data.timerSeconds, 213598);
  assert.equal(kv.writes.at(-1).options.expirationTtl, runConstants.RUN_TTL_SECONDS);
});

test("trace retention is capped and marked without hiding terminal status", async () => {
  const kv = makeKv();
  const id = "1123456789abcdef0123456789abcdef0123";
  const recorder = await createRunRecorder({ kv, mode: "worker", id, now: () => 0 });
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (let index = 0; index < runConstants.MAX_TRACE_EVENTS + 2; index += 1) {
      await recorder.trace({ code: "poll", message: `Poll ${index}`, data: { poll: index } });
    }
    await recorder.finalize({ operations: [] });
  } finally {
    console.log = originalLog;
  }
  const record = await readRun(kv, id);
  assert.equal(record.trace.length, 500);
  assert.equal(record.traceTruncated, true);
  assert.equal(record.status, "noop");
});

test("run index tolerates corruption and retains only the newest 400 summaries", async () => {
  const oldRuns = Array.from({ length: runConstants.MAX_RUN_SUMMARIES }, (_, index) => ({
    id: index.toString(16).padStart(36, "0"),
    status: "noop",
    startedAt: "2026-07-19T00:00:00.000Z",
    operations: [],
  }));
  const kv = makeKv(new Map([[runConstants.RUN_INDEX_KEY, JSON.stringify({ runs: oldRuns })]]));
  const id = "abcdef0123456789abcdef0123456789abcd";
  await createRunRecorder({ kv, mode: "worker", id, now: () => 0 });
  const runs = await readRuns(kv);
  assert.equal(runs.length, 400);
  assert.equal(runs[0].id, id);
  assert.ok(!runs.some((run) => run.id === oldRuns.at(-1).id));

  const corruptKv = makeKv(new Map([[runConstants.RUN_INDEX_KEY, "not-json"]]));
  assert.deepEqual(await readRuns(corruptKv), []);
});

test("run pages are escaped, read-only, routable, and expose chronological traces", async () => {
  const id = "2123456789abcdef0123456789abcdef0123";
  const run = {
    id,
    status: "partial",
    scheduledAt: "2026-07-20T09:58:00.000Z",
    startedAt: "2026-07-20T09:58:01.000Z",
    finishedAt: "2026-07-20T09:58:05.000Z",
    durationMs: 4000,
    mode: "worker",
    operations: [{ operation: "enroll", classType: "WOD <script>", classDate: "2026-07-22", classTime: "06:30", outcome: "failure" }],
    trace: [{ at: "2026-07-20T09:58:02.000Z", elapsedMs: 1000, level: "info", scope: "poll", code: "waiting", message: "Opening in 4 seconds; retrying in 1 second", data: { timerSeconds: 4 } }],
    traceTruncated: false,
  };
  const html = renderRunPage(run, { basePath: "/regybox" });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /Opening in 4 seconds; retrying in 1 second/);
  assert.match(html, /href="\/regybox\/runs"/);

  const kv = makeKv(new Map([
    [`${runConstants.RUN_PREFIX}${id}`, JSON.stringify(run)],
    [runConstants.RUN_INDEX_KEY, JSON.stringify({ runs: [run] })],
  ]));
  const listResponse = await handleRunsRequest(kv, { basePath: "/regybox", nowMs: Date.parse(run.finishedAt) });
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get("cache-control"), "no-store");
  assert.match(await listResponse.text(), new RegExp(`/regybox/runs/${id}`));
  assert.equal((await handleRunRequest(kv, id)).status, 200);
  assert.equal((await handleRunRequest(kv, "bad-id")).status, 404);

  const model = await buildStatusModel({ env: {}, kv, now: () => Date.parse(run.finishedAt), basePath: "/regybox" });
  const statusHtml = renderStatusPage(model);
  assert.match(statusHtml, /Recent runs/);
  assert.match(statusHtml, new RegExp(`/regybox/runs/${id}`));
  assert.match(statusHtml, /View all retained runs/);

  const routedList = await worker.fetch(
    new Request("https://worker.example.test/regybox/runs"),
    { REGYBOX_STATE: kv },
    {},
  );
  assert.equal(routedList.status, 200);
  assert.match(await routedList.text(), /Regybox run history/);
  const routedDetail = await worker.fetch(
    new Request(`https://worker.example.test/regybox/runs/${id}`),
    { REGYBOX_STATE: kv },
    {},
  );
  assert.equal(routedDetail.status, 200);
  assert.match(await routedDetail.text(), /Regybox run details/);
});

test("recorder write failures never break enrollment execution", async () => {
  const kv = makeKv();
  const warnings = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => warnings.push(args);
  console.log = () => {};
  try {
    const summary = await executePlan({
      env: { PHPSESSID: "session", REGYBOX_USER: "user" },
      kv,
      dispatches: [{
        operation: "enroll",
        inputs: {
          operation: "enroll",
          "class-date": "2026-07-22",
          "class-time": "06:30",
          "class-type": "WOD",
          "cache-key": "state",
        },
      }],
      createClient: () => ({ bootstrapSession: async () => {} }),
      runOperationImpl: async ({ onTrace }) => {
        await onTrace({ code: "poll", message: "Polling" });
        return { status: "success" };
      },
      recorder: { id: "3123456789abcdef0123456789abcdef0123", trace: async () => { throw new Error("KV unavailable"); } },
      onResult: async () => {},
    });
    assert.equal(summary.operations[0].outcome, "success");
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  assert.ok(warnings.some(([message]) => message === "regybox: run trace write failed:"));
});

test("run outcome status distinguishes successful, noop, partial, and failed runs", () => {
  assert.equal(outcomeStatus([]), "noop");
  assert.equal(outcomeStatus([{ outcome: "noop" }]), "noop");
  assert.equal(outcomeStatus([{ outcome: "success" }]), "success");
  assert.equal(outcomeStatus([{ outcome: "success" }, { outcome: "failure" }]), "partial");
  assert.equal(outcomeStatus([{ outcome: "failure" }]), "failure");
});

test("scheduled calendar failures finalize a visible failure timeline", async () => {
  const kv = makeKv();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(
      handleScheduled({
        GITHUB_TOKEN: "token",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        CALENDAR_URL: "https://calendar.example.test/private.ics",
        REGYBOX_STATE: kv,
      }, {
        scheduledAt: Date.parse("2026-07-20T10:28:00.000Z"),
        now: () => Date.parse("2026-07-20T10:28:01.000Z"),
      }),
      /Calendar fetch failed: 503/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
  const summaries = await readRuns(kv);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, "failure");
  assert.equal(summaries[0].scheduledAt, "2026-07-20T10:28:00.000Z");
  const run = await readRun(kv, summaries[0].id);
  assert.deepEqual(run.operations, [{
    operation: "calendar",
    outcome: "failure",
    errorCode: "calendar_or_plan_failure",
  }]);
  assert.deepEqual(run.trace.map((event) => event.code), [
    "calendar_fetch_started",
    "calendar_or_plan_failed",
  ]);
});

test("scheduled execution setup failures never inherit operations from the previous run", async () => {
  const previousOperations = [{
    operation: "enroll",
    classDate: "2026-07-19",
    classTime: "06:30",
    classType: "WOD",
    outcome: "success",
  }];
  const kv = makeKv(new Map([["regybox:v1:last_run", JSON.stringify({
    ranAt: "2026-07-19T05:30:00.000Z",
    mode: "worker",
    plannedOperations: 1,
    operations: previousOperations,
  })]]));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  globalThis.fetch = async () => new Response("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n");
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(
      handleScheduled({
        CALENDAR_URL: "https://calendar.example.test/private.ics",
        CALENDAR_EVENT_NAMES: "Crossfit",
        CLASS_TYPE: "WOD",
        REGYBOX_STATE: kv,
      }, {
        scheduledAt: Date.parse("2026-07-20T10:28:00.000Z"),
        now: () => Date.parse("2026-07-20T10:28:01.000Z"),
      }),
      /Missing scheduler configuration variables/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }

  const summaries = await readRuns(kv);
  assert.equal(summaries[0].status, "failure");
  const run = await readRun(kv, summaries[0].id);
  assert.deepEqual(run.operations, []);
  assert.ok(!JSON.stringify(run).includes("2026-07-19"));
});
