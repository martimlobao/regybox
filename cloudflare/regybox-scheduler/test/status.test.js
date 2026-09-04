import assert from "node:assert/strict";
import test from "node:test";

import { buildStatusModel, renderRunsPage, renderStatusPage } from "../src/status.js";
import { buildFailureFingerprint, errorPayload } from "../src/failures.js";
import { BookrLoginError, BookrSessionRefreshRequiredError, BookrSubscriptionError } from "../src/bookr.js";

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
  assert.doesNotMatch(calendar?.hint ?? "", /separated class title and box/);
});

test("Bookr calendar checks explain legacy exact-box class matching", async () => {
  const model = await buildStatusModel({
    env: workerEnv({
      BOOKING_PLATFORM: "bookr",
      BOOKR_AUTH_COOKIE: "sb-jphimrpybgssduyuziaw-auth-token.0=base64-secret",
      CLASS_MAP: "CrossFit = WOD Rato, Weekend WOD Rato; Open Box = Open Box Rato",
    }),
    kv: makeKv(),
    now: () => NOW_MS,
    createBookrClient: () => ({
      bootstrapSession: async () => ({ subscriptionId: "11111111-1111-4111-8111-111111111111" }),
    }),
    createClient: () => { throw new Error("Regybox client must not be called"); },
    fetchImpl: async () => new Response(ICS_WITH_EVENT("20260713T063000Z")),
  });
  const calendar = flatChecks(model).find((item) => item.text.startsWith("Calendar is reachable"));
  assert.match(calendar?.hint, /WOD Rato → WOD at Rato/);
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

test("an empty failed Bookr run is shown as a provider-aware failure", async () => {
  const lastRun = {
    ranAt: new Date(NOW_MS - 2 * 60_000).toISOString(),
    platform: "bookr",
    status: "failure",
    mode: "worker",
    plannedOperations: 0,
    operations: [],
  };
  const model = await buildStatusModel({
    env: workerEnv({ BOOKING_PLATFORM: "bookr", BOOKR_AUTH_COOKIE: "" }),
    kv: makeKv({ "regybox:v1:last_run": JSON.stringify(lastRun) }),
    now: () => NOW_MS,
    fetchImpl: async () => new Response(ICS_WITH_EVENT("20260713T063000Z")),
  });
  const summary = flatChecks(model).find((item) => item.text.startsWith("Last check:"));
  assert.equal(summary?.level, "bad");
  assert.match(summary.text, /Bookr\.fit: scheduler run failed/);
  assert.doesNotMatch(summary.text, /session_refresh_failed|undefined/);
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

test("Bookr status checks use the Bookr credential and active subscription without exposing it", async () => {
  const authCookie = "sb-jphimrpybgssduyuziaw-auth-token.0=base64-secret";
  const model = await buildStatusModel({
    env: workerEnv({
      BOOKING_PLATFORM: "bookr",
      BOOKR_AUTH_COOKIE: authCookie,
      CALENDAR_URL: "",
      PHPSESSID: "legacy-cookie-must-not-be-used",
      REGYBOX_USER: "legacy-user-must-not-be-used",
    }),
    kv: makeKv(),
    now: () => NOW_MS,
    createBookrClient: (options) => {
      assert.equal(options.authCookie, authCookie);
      assert.equal(options.persistSession, false);
      return { bootstrapSession: async () => ({ subscriptionId: "11111111-1111-4111-8111-111111111111" }) };
    },
    createClient: () => { throw new Error("Regybox client must not be called"); },
  });
  assert.equal(model.platform, "bookr");
  const texts = flatChecks(model).map((item) => `${item.level}:${item.text}`);
  assert.ok(texts.includes("ok:Booking platform: Bookr.fit"));
  assert.ok(texts.includes("ok:Bookr.fit authentication cookie is set"));
  assert.ok(texts.includes("ok:Bookr.fit accepts your login"));
  assert.ok(texts.includes("ok:Bookr.fit has an active subscription"));
  assert.doesNotMatch(JSON.stringify(model), /base64-secret|legacy-cookie|legacy-user/);
  const html = renderStatusPage(model);
  assert.match(html, /Bookr\.fit auto-enroller/);
  assert.doesNotMatch(html, /base64-secret|11111111-1111-4111-8111-111111111111/);
});

test("invalid platform status performs no provider or calendar requests", async () => {
  let calls = 0;
  const model = await buildStatusModel({
    env: workerEnv({ BOOKING_PLATFORM: "unknown", CALENDAR_URL: "https://calendar.example.test/feed.ics" }),
    kv: makeKv(),
    createClient: () => { calls += 1; throw new Error("must not be called"); },
    createBookrClient: () => { calls += 1; throw new Error("must not be called"); },
    fetchImpl: async () => { calls += 1; throw new Error("must not be called"); },
  });
  assert.equal(calls, 0);
  assert.ok(flatChecks(model).some((item) => item.level === "bad" && item.text === "Booking platform is invalid"));
  const html = renderStatusPage(model);
  assert.match(html, /<h1>Unknown auto-enroller<\/h1>/);
  assert.match(html, /Mode: not configured yet · Unknown · checked/);
  assert.doesNotMatch(html, /<h1>Regybox auto-enroller<\/h1>/);
});

test("Bookr run history labels legacy Regybox records after a provider switch", () => {
  const legacyRun = {
    id: "0123456789abcdef0123456789abcdef0123",
    status: "success",
    startedAt: "2026-07-12T10:00:00.000Z",
    durationMs: 1000,
    operations: [],
  };
  const legacyHtml = renderRunsPage([legacyRun], {
    platform: "bookr",
    nowMs: NOW_MS,
  });
  assert.match(legacyHtml, /<h1>Bookr\.fit run history<\/h1>/);
  assert.match(legacyHtml, /<th>Platform<\/th>/);
  assert.match(legacyHtml, /<td>Regybox<\/td>/);

  const bookrRun = { ...legacyRun, platform: "bookr" };
  const homogeneousHtml = renderRunsPage([bookrRun], {
    platform: "bookr",
    nowMs: NOW_MS,
  });
  assert.doesNotMatch(homogeneousHtml, /<th>Platform<\/th>/);
});

test("Bookr dispatch configuration is shown as an actionable setup error", async () => {
  const model = await buildStatusModel({
    env: workerEnv({
      BOOKING_PLATFORM: "bookr",
      BOOKR_AUTH_COOKIE: "cookie",
      CALENDAR_URL: "",
      GITHUB_TOKEN: "token",
      GITHUB_OWNER: "owner",
      GITHUB_REPO: "repo",
    }),
    kv: makeKv(),
    createBookrClient: () => ({ bootstrapSession: async () => ({ subscriptionId: "11111111-1111-4111-8111-111111111111" }) }),
  });
  const unsupported = flatChecks(model).find((item) => item.text.includes("requires self-contained Worker"));
  assert.equal(unsupported?.level, "bad");
  assert.match(unsupported?.hint, /GITHUB_TOKEN/);
});

test("Bookr failures have provider-specific recovery text and redact session details", () => {
  const error = new Error("BOOKR_AUTH_COOKIE=sb-jphimrpybgssduyuziaw-auth-token.0=secret-cookie");
  error.name = "BookrLoginError";
  const payload = errorPayload(error, { platform: "bookr" });
  assert.equal(payload.errorCode, "login_error");
  assert.match(payload.userTitle, /Bookr\.fit/);
  assert.match(payload.userNextSteps.join(" "), /BOOKR_AUTH_COOKIE/);
  assert.doesNotMatch(payload.technicalMessage, /secret-cookie/);
  assert.match(buildFailureFingerprint({ operation: "enroll", error, platform: "bookr" }), /Unable to log in to Bookr\.fit/);
});

test("Bookr subscription failures are an explicit red live check", async () => {
  const model = await buildStatusModel({
    env: workerEnv({ BOOKING_PLATFORM: "bookr", BOOKR_AUTH_COOKIE: "auth-cookie", CALENDAR_URL: "" }),
    kv: makeKv(),
    createBookrClient: () => ({ bootstrapSession: async () => { throw new BookrSubscriptionError(); } }),
  });
  const subscription = flatChecks(model).find((item) => item.text === "Bookr.fit has no active subscription");
  const login = flatChecks(model).find((item) => item.text === "Bookr.fit accepts your login");
  assert.equal(login?.level, "ok");
  assert.equal(subscription?.level, "bad");
  assert.match(subscription?.hint, /membership is active/);
});

test("Bookr status reports an expiring valid session without claiming login or subscription success", async () => {
  const model = await buildStatusModel({
    env: workerEnv({ BOOKING_PLATFORM: "bookr", BOOKR_AUTH_COOKIE: "auth-cookie", CALENDAR_URL: "" }),
    kv: makeKv(),
    createBookrClient: () => ({ bootstrapSession: async () => { throw new BookrSessionRefreshRequiredError(); } }),
  });
  const checks = flatChecks(model);
  const refresh = checks.find((item) => item.text === "Bookr.fit session needs refresh");
  assert.equal(refresh?.level, "warn");
  assert.match(refresh?.hint, /read-only|next run/);
  assert.equal(checks.some((item) => item.text === "Bookr.fit accepts your login"), false);
  assert.equal(checks.some((item) => item.text === "Bookr.fit has an active subscription"), false);
  assert.equal(checks.some((item) => item.level === "bad" && /rejected your login/.test(item.text)), false);
});

test("Bookr status still marks invalid sessions as rejected login", async () => {
  const model = await buildStatusModel({
    env: workerEnv({ BOOKING_PLATFORM: "bookr", BOOKR_AUTH_COOKIE: "auth-cookie", CALENDAR_URL: "" }),
    kv: makeKv(),
    createBookrClient: () => ({ bootstrapSession: async () => { throw new BookrLoginError(); } }),
  });
  const rejected = flatChecks(model).find((item) => item.text.startsWith("Bookr.fit rejected your login"));
  assert.equal(rejected?.level, "bad");
  assert.match(rejected?.hint, /sb-.*auth-token/);
});

test("historical run and activity providers are not relabeled when the platform switches", async () => {
  const lastRun = {
    platform: "regybox",
    ranAt: new Date(NOW_MS - 2 * 60_000).toISOString(),
    operations: [{ operation: "enroll", classDate: "2026-07-14", classTime: "06:30", classType: "WOD", outcome: "success" }],
  };
  const activity = [{
    platform: "bookr",
    at: new Date(NOW_MS - 60_000).toISOString(),
    operation: "enroll", classDate: "2026-07-15", classTime: "06:30", classType: "WOD", outcome: "success",
  }];
  const model = await buildStatusModel({
    env: workerEnv({ BOOKING_PLATFORM: "bookr", BOOKR_AUTH_COOKIE: "auth-cookie", CALENDAR_URL: "" }),
    kv: makeKv({
      "regybox:v1:last_run": JSON.stringify(lastRun),
      "regybox:v1:activity": JSON.stringify(activity),
    }),
    createBookrClient: () => ({ bootstrapSession: async () => ({ subscriptionId: "11111111-1111-4111-8111-111111111111" }) }),
    now: () => NOW_MS,
  });
  const last = flatChecks(model).find((item) => item.text.startsWith("Last check:"));
  assert.match(last.text, /Last check: 2 minutes ago — enrolled in WOD/);
  assert.doesNotMatch(last.text, /Bookr\.fit/);
  const recent = model.sections.find((section) => section.title === "Recent activity").checks[0];
  assert.match(recent.text, /^Bookr\.fit: Enrolled in WOD/);
});
