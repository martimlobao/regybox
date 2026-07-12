import assert from "node:assert/strict";
import test from "node:test";

import { buildStatusModel, renderStatusPage } from "../src/status.js";

const ICS_WITH_EVENT = (start) =>
  [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:event-1",
    `DTSTART:${start}`,
    "SUMMARY:CrossFit",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

const NOW_MS = Date.parse("2026-07-12T10:00:00Z");

function makeKv(entries = {}) {
  return {
    async get(key) {
      return entries[key] ?? null;
    },
  };
}

function workerEnv(overrides = {}) {
  return {
    PHPSESSID: "sess",
    REGYBOX_USER: "123",
    CALENDAR_URL: "https://calendar.example.test/feed.ics",
    CALENDAR_EVENT_NAMES: "CrossFit",
    ...overrides,
  };
}

function okClient() {
  return { fetchClassesHtml: async () => "<html>classes</html>" };
}

function flatChecks(model) {
  return model.sections.flatMap((section) => section.checks);
}

test("a fully configured worker shows green setup and live checks", async () => {
  const model = await buildStatusModel({
    env: workerEnv(),
    kv: makeKv(),
    now: () => NOW_MS,
    createClient: okClient,
    fetchImpl: async () => new Response(ICS_WITH_EVENT("20260713T063000Z")),
  });
  assert.equal(model.mode, "self-contained");
  const texts = flatChecks(model).map((item) => `${item.level}:${item.text}`);
  assert.ok(texts.some((text) => text === "ok:Regybox cookies are set"));
  assert.ok(texts.some((text) => text === "ok:Calendar link is set"));
  assert.ok(texts.some((text) => text.startsWith("off:Email notifications are off")));
  assert.ok(texts.some((text) => text === "ok:Regybox accepts your login"));
  assert.ok(texts.some((text) => /^ok:Calendar is reachable — 1 upcoming/.test(text)));
  assert.ok(texts.some((text) => text.startsWith("warn:The scheduler has not run yet")));
});

test("missing configuration produces actionable hints and no live checks", async () => {
  const model = await buildStatusModel({
    env: {},
    kv: makeKv(),
    now: () => NOW_MS,
    createClient: () => {
      throw new Error("must not be called");
    },
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(model.mode, "not configured yet");
  const bad = flatChecks(model).filter((item) => item.level === "bad");
  assert.equal(bad.length, 2);
  for (const item of bad) {
    assert.ok(item.hint, `${item.text} should carry a remediation hint`);
  }
});

test("an expired cookie is reported as an expired login with remediation", async () => {
  const loginError = new Error("login");
  loginError.name = "RegyboxLoginError";
  const model = await buildStatusModel({
    env: workerEnv({ CALENDAR_URL: "" }),
    kv: makeKv(),
    now: () => NOW_MS,
    createClient: () => ({
      fetchClassesHtml: async () => {
        throw loginError;
      },
    }),
  });
  const rejected = flatChecks(model).find((item) =>
    item.text.startsWith("Regybox rejected your login"),
  );
  assert.equal(rejected?.level, "bad");
  assert.match(rejected.hint, /PHPSESSID/);
});

test("a reachable calendar without matching events warns about event names", async () => {
  const model = await buildStatusModel({
    env: workerEnv({ CALENDAR_EVENT_NAMES: "Pilates" }),
    kv: makeKv(),
    now: () => NOW_MS,
    createClient: okClient,
    fetchImpl: async () => new Response(ICS_WITH_EVENT("20260713T063000Z")),
  });
  const calendar = flatChecks(model).find((item) => item.text.includes("no “Pilates” events"));
  assert.equal(calendar?.level, "warn");
});

test("an invalid CLASS_MAP is shown in Setup without hiding the parse error", async () => {
  const model = await buildStatusModel({
    env: workerEnv({ CLASS_MAP: "CrossFit WOD" }),
    kv: makeKv(),
    now: () => NOW_MS,
    createClient: okClient,
    fetchImpl: async () => new Response(ICS_WITH_EVENT("20260713T063000Z")),
  });
  const invalid = model.sections
    .find((section) => section.title === "Setup")
    .checks.find((item) => item.text.startsWith("CLASS_MAP is invalid:"));
  assert.equal(invalid?.level, "bad");
  assert.match(invalid.text, /CrossFit WOD/);
  assert.match(invalid.hint, /CrossFit = WOD/);
});

test("CLASS_MAP booking rules are shown in the calendar live check", async () => {
  const model = await buildStatusModel({
    env: workerEnv({
      CLASS_MAP: "Weightlifting = Weightlifting Rato; CrossFit = WOD, Weekend WOD",
    }),
    kv: makeKv(),
    now: () => NOW_MS,
    createClient: okClient,
    fetchImpl: async () => new Response(ICS_WITH_EVENT("20260713T063000Z")),
  });
  const calendar = flatChecks(model).find((item) => item.text.startsWith("Calendar is reachable"));
  assert.match(calendar?.hint, /Weightlifting → Weightlifting Rato/);
  assert.match(calendar?.hint, /CrossFit → WOD \(backup: Weekend WOD\)/);
});

test("the last run section summarizes results and failures", async () => {
  const lastRun = {
    ranAt: new Date(NOW_MS - 12 * 60_000).toISOString(),
    mode: "worker",
    plannedOperations: 2,
    operations: [
      { operation: "enroll", classDate: "2026-07-14", classTime: "06:30", classType: "WOD", outcome: "success" },
      { operation: "unenroll", classDate: "2026-07-15", classTime: "06:30", classType: "WOD", outcome: "failure", errorCode: "login_error" },
    ],
  };
  const model = await buildStatusModel({
    env: workerEnv({ CALENDAR_URL: "", PHPSESSID: "", REGYBOX_USER: "" }),
    kv: makeKv({ "regybox:v1:last_run": JSON.stringify(lastRun) }),
    now: () => NOW_MS,
  });
  const summary = flatChecks(model).find((item) => item.text.startsWith("Last check:"));
  assert.equal(summary?.level, "bad");
  assert.match(summary.text, /12 minutes ago/);
  assert.match(summary.text, /failed \(login_error\)/);
});

test("a calendar-level failure is described without class placeholders", async () => {
  const lastRun = {
    ranAt: new Date(NOW_MS - 5 * 60_000).toISOString(),
    mode: "worker",
    plannedOperations: 0,
    operations: [{ operation: "calendar", outcome: "failure", errorCode: "calendar_or_plan_failure" }],
  };
  const model = await buildStatusModel({
    env: {},
    kv: makeKv({ "regybox:v1:last_run": JSON.stringify(lastRun) }),
    now: () => NOW_MS,
  });
  const summary = flatChecks(model).find((item) => item.text.startsWith("Last check:"));
  assert.equal(summary?.level, "bad");
  assert.ok(!summary.text.includes("undefined"));
  assert.match(summary.text, /calendar could not be checked \(calendar_or_plan_failure\)/);
});

test("recent activity is newest-first with outcome levels and is omitted when empty", async () => {
  const activity = [
    {
      at: new Date(NOW_MS - 2 * 60 * 60_000).toISOString(),
      operation: "enroll",
      classDate: "2026-07-14",
      classTime: "06:30",
      classType: "WOD Rato",
      outcome: "success",
    },
    {
      at: new Date(NOW_MS - 5 * 60_000).toISOString(),
      operation: "enroll",
      classDate: "2026-07-15",
      classTime: "06:30",
      classType: "WOD",
      outcome: "noop",
    },
    {
      at: new Date(NOW_MS - 60_000).toISOString(),
      operation: "calendar",
      outcome: "failure",
      errorCode: "calendar_or_plan_failure",
    },
  ];
  const model = await buildStatusModel({
    env: {},
    kv: makeKv({ "regybox:v1:activity": JSON.stringify(activity) }),
    now: () => NOW_MS,
  });
  const section = model.sections.find(({ title }) => title === "Recent activity");
  assert.deepEqual(section.checks.map(({ level }) => level), ["ok", "off", "bad"]);
  assert.match(section.checks[0].text, /^Enrolled in WOD Rato on 2026-07-14 at 06:30 — 2 hours ago$/);
  assert.match(section.checks[2].text, /calendar could not be checked/);

  const empty = await buildStatusModel({ env: {}, kv: makeKv(), now: () => NOW_MS });
  assert.equal(empty.sections.some(({ title }) => title === "Recent activity"), false);
});

test("the rendered page is safe, read-only HTML without secrets", async () => {
  const model = await buildStatusModel({
    env: workerEnv({ PHPSESSID: "super-secret-cookie<script>" }),
    kv: makeKv(),
    now: () => NOW_MS,
    createClient: okClient,
    fetchImpl: async () => new Response(ICS_WITH_EVENT("20260713T063000Z")),
  });
  const html = renderStatusPage(model);
  assert.ok(!html.includes("super-secret-cookie"));
  assert.ok(html.includes('name="robots" content="noindex"'));
  assert.ok(html.includes("never shows your credentials"));
  assert.ok(!html.includes("<script>"));
});
