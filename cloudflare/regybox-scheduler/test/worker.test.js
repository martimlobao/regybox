import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
} from "../src/index.js";
import worker from "../src/index.js";

const baseEnv = {
  GITHUB_OWNER: "martim",
  GITHUB_REPO: "regybox",
  GITHUB_WORKFLOW: "class_operation.yml",
  GITHUB_REF: "main",
  CALENDAR_EVENT_NAMES: "Crossfit",
  CLASS_TYPE: "WOD",
};

function makeKv(existing = new Map()) {
  const writes = [];
  const gets = [];
  return {
    writes,
    gets,
    async get(key) {
      gets.push(key);
      return existing.get(key) ?? null;
    },
    async put(key, value) {
      writes.push({ key, value });
      existing.set(key, value);
    },
    async list({ prefix }) {
      return {
        keys: [...existing.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
      };
    },
  };
}

function makePaginatedKv(pages, values) {
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async list({ prefix, cursor }) {
      const pageIndex = cursor ? Number.parseInt(cursor, 10) : 0;
      const keys = pages[pageIndex]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      const nextPageIndex = pageIndex + 1;
      return {
        keys,
        list_complete: nextPageIndex >= pages.length,
        cursor: String(nextPageIndex),
      };
    },
  };
}

test("default lookahead is 73 hours", () => {
  // defaults when not set
  assert.equal(defaultLookaheadHours({}), 73);

  // valid positive numeric override
  assert.equal(defaultLookaheadHours({ LOOKAHEAD_HOURS: "96" }), 96);

  // non-positive or non-numeric values fall back to default
  assert.equal(defaultLookaheadHours({ LOOKAHEAD_HOURS: "0" }), 73);
  assert.equal(defaultLookaheadHours({ LOOKAHEAD_HOURS: "-5" }), 73);
  assert.equal(defaultLookaheadHours({ LOOKAHEAD_HOURS: "not-a-number" }), 73);
});

test("normalizeList accepts comma-separated values", () => {
  assert.deepEqual(normalizeList(" Crossfit, Strength ,, "), ["Crossfit", "Strength"]);
});

test("Bookr calendar errors are redacted before reaching the console", async () => {
  const kv = makeKv();
  const unsafe = new Error(
    'Cookie: sb-jphimrpybgssduyuziaw-auth-token.0=secret-cookie; ' +
      'Authorization: Bearer access-secret https://bookr.fit/api/dashboard?date=2026-09-05 ' +
      '11111111-1111-4111-8111-111111111111 {"raw":"private-body"}',
  );
  unsafe.name = "BookrLoginError";
  const errors = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async () => { throw unsafe; };
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(
      worker.scheduled(
        { scheduledTime: "2026-09-04T00:00:00.000Z" },
        {
          BOOKING_PLATFORM: "bookr",
          BOOKR_AUTH_COOKIE: "bootstrap-cookie",
          CALENDAR_URL: "https://calendar.example.test/private.ics?secret=query",
          REGYBOX_STATE: kv,
        },
        {},
      ),
      (error) => error === unsafe,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }

  const output = errors.flat().map(String).join(" ");
  assert.match(output, /Bookr\.fit error \(login_error\)/);
  assert.doesNotMatch(
    output,
    /secret-cookie|access-secret|bookr\.fit\/api|date=2026-09-05|11111111-1111-4111-8111-111111111111|private-body|sb-jphimrpybgssduyuziaw-auth-token/,
  );
});

test("Bookr calendar fetch diagnostics retain the calendar subsystem and HTTP status", async () => {
  const kv = makeKv();
  const errors = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(
      worker.scheduled(
        { scheduledTime: "2026-09-04T00:00:00.000Z" },
        {
          BOOKING_PLATFORM: "bookr",
          BOOKR_AUTH_COOKIE: "bootstrap-cookie",
          CALENDAR_URL: "https://calendar.example.test/private.ics",
          REGYBOX_STATE: kv,
        },
        {},
      ),
      /Calendar fetch failed: 503/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }

  const output = errors.flat().map(String).join(" ");
  assert.match(output, /calendar\/plan failed: Calendar fetch failed: 503/);
  assert.doesNotMatch(output, /Bookr\.fit error \(unexpected_failure\)/);
});

test("path-prefixed incident links route to the incident handler", async () => {
  const id = "0123456789abcdef0123456789abcdef0123";
  const kv = makeKv(
    new Map([
      [
        `regybox:v1:incident:${id}`,
        JSON.stringify({ timestamp: "2026-07-13T12:00:00.000Z", errorName: "Error" }),
      ],
    ]),
  );

  const response = await worker.fetch(
    new Request(`https://worker.example.test/regybox/incidents/${id}`),
    { REGYBOX_STATE: kv },
    {},
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Regybox incident details/);
});

test("root favicon requests do not overwrite the remembered status origin", async () => {
  const kv = makeKv(new Map([["regybox:v1:status_origin", "https://worker.example.test/regybox"]]));
  const response = await worker.fetch(
    new Request("https://worker.example.test/favicon.ico"),
    { REGYBOX_STATE: kv },
    {},
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(kv.writes.length, 0);
  assert.equal(await kv.get("regybox:v1:status_origin"), "https://worker.example.test/regybox");
});

test("path-prefixed favicon requests do not poison prefixed status routing", async () => {
  const kv = makeKv();
  const status = await worker.fetch(
    new Request("https://worker.example.test/regybox"),
    { REGYBOX_STATE: kv },
    {},
  );
  assert.equal(status.status, 200);
  assert.equal(await kv.get("regybox:v1:status_origin"), "https://worker.example.test/regybox");
  kv.writes.length = 0;

  const favicon = await worker.fetch(
    new Request("https://worker.example.test/regybox/favicon.ico"),
    { REGYBOX_STATE: kv },
    {},
  );
  assert.equal(favicon.status, 204);
  assert.equal(favicon.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(kv.writes.length, 0);
  assert.equal(await kv.get("regybox:v1:status_origin"), "https://worker.example.test/regybox");

  const prefixedStatus = await worker.fetch(
    new Request("https://worker.example.test/regybox"),
    { REGYBOX_STATE: kv },
    {},
  );
  assert.equal(prefixedStatus.status, 200);
  assert.match(await prefixedStatus.text(), /Regybox auto-enroller/);
});

test("recurring calendar events expand inside the lookahead window", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:daily-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T063000Z",
    "RRULE:FREQ=DAILY;COUNT=4",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
    lookaheadHours: 72,
    calendarEventNames: ["Crossfit"],
  });

  assert.deepEqual(
    events.map((event) => event.classDate),
    ["2026-06-18", "2026-06-19", "2026-06-20"],
  );
});

test("recurring calendar events beyond lookahead window are excluded", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:daily-class-beyond-window",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T063000Z",
    // Five daily occurrences; only the first three fall within a 72-hour window
    "RRULE:FREQ=DAILY;COUNT=5",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
    lookaheadHours: 72,
    calendarEventNames: ["Crossfit"],
  });

  assert.deepEqual(
    events.map((event) => event.classDate),
    ["2026-06-18", "2026-06-19", "2026-06-20"],
  );
});

test("UTC calendar event times are formatted in the configured timezone", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:timezone-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
    lookaheadHours: 72,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.equal(events[0].classDate, "2026-06-18");
  assert.equal(events[0].classTime, "06:30");
});

test("missing KV entry dispatches enroll", async () => {
  const kv = makeKv();
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.equal(plan.dispatches.length, 1);
  assert.equal(plan.dispatches[0].operation, "enroll");
  assert.equal(plan.dispatches[0].inputs["class-type"], "WOD");
  assert.equal(plan.dispatches[0].inputs["calendar-event-name"], "Crossfit");
  assert.equal(plan.dispatches[0].inputs["class-date"], "2026-06-18");
  assert.equal(plan.dispatches[0].inputs["class-time"], "06:30");
});

test("Bookr calendar state is isolated from legacy Regybox enrollment state", async () => {
  const legacyKey = "regybox:v1:calendar:one-class:2026-06-18T05:30:00.000Z";
  const kv = makeKv(new Map([[legacyKey, JSON.stringify({ state: "enrolled" })]]));
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: { ...baseEnv, BOOKING_PLATFORM: "bookr" },
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.equal(plan.dispatches.length, 1);
  assert.match(plan.dispatches[0].inputs["cache-key"], /^regybox:v2:calendar:bookr:/);
  assert.ok(!kv.gets.includes(legacyKey));
});

test("existing KV entry with matching calendar event skips dispatch", async () => {
  const key = "regybox:v1:calendar:one-class:2026-06-18T06:30:00.000Z";
  const kv = makeKv(new Map([[key, JSON.stringify({ state: "enrolled" })]]));
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T063000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.deepEqual(plan.dispatches, []);
});

test("buildPlan reuses listed KV values for active event cache checks", async () => {
  const key = "regybox:v1:calendar:one-class:2026-06-18T06:30:00.000Z";
  const kv = makeKv(new Map([[key, JSON.stringify({ state: "enrolled" })]]));
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T063000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.deepEqual(kv.gets, [key]);
});

test("buildPlan sweeps stale enrolled entries across paginated KV listings", async () => {
  const firstPageKey = "regybox:v1:calendar:old-class:2026-06-18T06:30:00.000Z";
  const secondPageKey = "regybox:v1:calendar:old-class:2026-06-19T06:30:00.000Z";
  const kv = makePaginatedKv(
    [[firstPageKey], [secondPageKey]],
    new Map([
      [
        firstPageKey,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-06-18",
          classTime: "06:30",
          classType: "WOD",
          calendarEventName: "Crossfit",
          calendarFingerprint: "old-class:2026-06-18T06:30:00.000Z",
        }),
      ],
      [
        secondPageKey,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-06-19",
          classTime: "06:30",
          classType: "WOD",
          calendarEventName: "Crossfit",
          calendarFingerprint: "old-class:2026-06-19T06:30:00.000Z",
        }),
      ],
    ]),
  );

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.deepEqual(
    plan.dispatches.map((dispatch) => dispatch.inputs["class-date"]),
    ["2026-06-18", "2026-06-19"],
  );
});

test("not-open KV entry skips dispatch before the five-and-a-half-hour refresh threshold", async () => {
  const key = "regybox:v1:calendar:one-class:2026-06-18T10:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "not_open",
          classDate: "2026-06-18",
          classTime: "11:30",
          classType: "WOD",
          enrollmentOpensAt: "2026-06-18T10:00:00.000Z",
          lastCheckedAt: "2026-06-18T00:00:00.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T103000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T05:29:59.999Z"),
  });

  assert.deepEqual(plan.dispatches, []);
});

test("not-open KV entry dispatches when enrollment opens within 60 minutes", async () => {
  const key = "regybox:v1:calendar:one-class:2026-06-18T05:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "not_open",
          classDate: "2026-06-18",
          classTime: "06:30",
          classType: "WOD",
          enrollmentOpensAt: "2026-06-18T01:20:00.000Z",
          lastCheckedAt: "2026-06-18T00:00:00.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:30:00Z"),
  });

  assert.equal(plan.dispatches.length, 1);
  assert.equal(plan.dispatches[0].operation, "enroll");
});

test("not-open KV entry dispatches when enrollment open time is missing", async () => {
  const key = "regybox:v1:calendar:one-class:2026-06-18T05:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "not_open",
          classDate: "2026-06-18",
          classTime: "06:30",
          classType: "WOD",
          lastCheckedAt: "2026-06-18T00:00:00.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:30:00Z"),
  });

  assert.equal(plan.dispatches.length, 1);
  assert.equal(plan.dispatches[0].operation, "enroll");
});

test("not-open KV entry dispatches when last check time is invalid", async () => {
  const key = "regybox:v1:calendar:one-class:2026-06-18T05:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "not_open",
          classDate: "2026-06-18",
          classTime: "06:30",
          classType: "WOD",
          enrollmentOpensAt: "2026-06-18T05:00:00.000Z",
          lastCheckedAt: "not-a-date",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:30:00Z"),
  });

  assert.equal(plan.dispatches.length, 1);
  assert.equal(plan.dispatches[0].operation, "enroll");
});

test("not-open KV entry dispatches at the five-and-a-half-hour refresh threshold", async () => {
  const key = "regybox:v1:calendar:one-class:2026-06-18T10:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "not_open",
          classDate: "2026-06-18",
          classTime: "11:30",
          classType: "WOD",
          enrollmentOpensAt: "2026-06-18T10:00:00.000Z",
          lastCheckedAt: "2026-06-18T00:00:00.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T103000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T05:30:00Z"),
  });

  assert.equal(plan.dispatches.length, 1);
  assert.equal(plan.dispatches[0].operation, "enroll");
});

test("half-hour cron cadence retries a not-open class within six hours", async () => {
  const key = "regybox:v1:calendar:one-class:2026-06-19T10:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "not_open",
          classDate: "2026-06-19",
          classTime: "11:30",
          classType: "WOD",
          enrollmentOpensAt: "2026-06-20T10:00:00.000Z",
          lastCheckedAt: "2026-06-18T17:30:01.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260619T103000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const beforeThreshold = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T22:58:00.000Z"),
  });
  const traces = [];
  const nextCron = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T23:28:00.000Z"),
    onTrace: async (event) => traces.push(event),
  });

  assert.deepEqual(beforeThreshold.dispatches, []);
  assert.equal(nextCron.dispatches.length, 1);
  assert.ok(
    new Date("2026-06-18T23:28:00.000Z").getTime() -
      new Date("2026-06-18T17:30:01.000Z").getTime() <
      6 * 60 * 60 * 1000,
  );
  const forcedRefresh = traces.find((event) => event.data?.reason === "forced_refresh_due");
  assert.equal(forcedRefresh.code, "calendar_event_scheduled");
  assert.equal(forcedRefresh.data.decision, "dispatch");
  assert.match(forcedRefresh.message, /forced refresh is due/);
  assert.doesNotMatch(JSON.stringify(traces), /one-class|regybox:v1:calendar/);
});

test("stale not-open KV entries do not dispatch unenroll", async () => {
  const key = "regybox:v1:calendar:old-class:2026-06-18T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "not_open",
          classDate: "2026-06-18",
          classTime: "06:30",
          classType: "WOD",
          enrollmentOpensAt: "2026-06-18T05:00:00.000Z",
          lastCheckedAt: "2026-06-18T00:00:00.000Z",
        }),
      ],
    ]),
  );

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
    now: new Date("2026-06-18T00:30:00Z"),
  });

  assert.deepEqual(plan.dispatches, []);
});

test("stale enrolled KV entry dispatches unenroll", async () => {
  const key = "regybox:v1:calendar:old-class:2026-06-18T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-06-18",
          classTime: "06:30",
          classType: "WOD",
          calendarEventName: "Crossfit",
          calendarFingerprint: "old-class:2026-06-18T06:30:00.000Z",
        }),
      ],
    ]),
  );

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.equal(plan.dispatches.length, 1);
  assert.equal(plan.dispatches[0].operation, "unenroll");
  assert.equal(plan.dispatches[0].inputs["class-date"], "2026-06-18");
  assert.equal(plan.dispatches[0].inputs["calendar-event-name"], "Crossfit");
});

test("renamed calendar event uid does not dispatch unenroll for same class slot", async () => {
  const oldKey = "regybox:v1:calendar:old-google-uid:2026-06-19T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        oldKey,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-06-19",
          classTime: "06:30",
          classType: "WOD",
          calendarFingerprint: "old-google-uid:2026-06-19T06:30:00.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:new-google-uid",
    "SUMMARY:Crossfit",
    "DTSTART:20260619T063000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.deepEqual(plan.dispatches, []);
});

test("same-time cached entry for different class does not cover active event", async () => {
  const oldKey = "regybox:v1:calendar:old-google-uid:2026-06-19T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        oldKey,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-06-19",
          classTime: "06:30",
          classType: "WOD",
          calendarEventName: "Crossfit",
          calendarFingerprint: "old-google-uid:2026-06-19T06:30:00.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:new-google-uid",
    "SUMMARY:Crossfit",
    "DTSTART:20260619T063000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: { ...baseEnv, CLASS_TYPE: "Weekend WOD" },
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.deepEqual(
    plan.dispatches.map((dispatch) => [
      dispatch.operation,
      dispatch.inputs["class-type"],
      dispatch.inputs["class-date"],
      dispatch.inputs["class-time"],
    ]),
    [
      ["enroll", "Weekend WOD", "2026-06-19", "06:30"],
      ["unenroll", "WOD", "2026-06-19", "06:30"],
    ],
  );
});

test("same-slot active events dispatch one enroll per plan", async () => {
  const kv = makeKv();
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:first-google-uid",
    "SUMMARY:Crossfit",
    "DTSTART:20260619T063000",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:second-google-uid",
    "SUMMARY:Crossfit",
    "DTSTART:20260619T063000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.deepEqual(
    plan.dispatches.map((dispatch) => [
      dispatch.operation,
      dispatch.inputs["class-type"],
      dispatch.inputs["class-date"],
      dispatch.inputs["class-time"],
    ]),
    [["enroll", "WOD", "2026-06-19", "06:30"]],
  );
});

test("weekly RRULE without BYDAY recurs on DTSTART weekday only", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T063000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
    lookaheadHours: 24 * 8,
    calendarEventNames: ["Crossfit"],
  });

  assert.deepEqual(
    events.map((event) => event.classDate),
    ["2026-06-18", "2026-06-25"],
  );
});

test("recurring calendar events respect EXDATE exclusions", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:excluded-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T063000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "EXDATE:20260619T063000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
    lookaheadHours: 72,
    calendarEventNames: ["Crossfit"],
  });

  assert.deepEqual(
    events.map((event) => event.classDate),
    ["2026-06-18", "2026-06-20"],
  );
});

test("recurring calendar events respect every repeated EXDATE property", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekday-class-with-separate-exdates",
    "SUMMARY:Crossfit",
    "DTSTART;TZID=Europe/Lisbon:20260619T063000",
    "RRULE:FREQ=WEEKLY;BYDAY=FR,MO,TH,TU,WE",
    "EXDATE;TZID=Europe/Lisbon:20260724T063000",
    "EXDATE;TZID=Europe/Lisbon:20260720T063000",
    "EXDATE;TZID=Europe/Lisbon:20260623T063000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-07-23T00:00:00Z"),
    lookaheadHours: 72,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.deepEqual(
    events.map((event) => [event.classDate, event.classTime]),
    [["2026-07-23", "06:30"]],
  );
});

test("moved recurring instance uses override time instead of original slot", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "EXDATE:20260703T053000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "SUMMARY:Crossfit",
    "DTSTART:20260703T073000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-29T00:00:00Z"),
    lookaheadHours: 120,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.deepEqual(
    events.map((event) => [event.classDate, event.classTime]),
    [
      ["2026-07-03", "08:30"],
    ],
  );
});

test("moved recurring instance uses override time without master EXDATE", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "SUMMARY:Crossfit",
    "DTSTART:20260703T073000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-29T00:00:00Z"),
    lookaheadHours: 120,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.deepEqual(
    events.map((event) => [event.classDate, event.classTime]),
    [["2026-07-03", "08:30"]],
  );
});

test("cancelled recurrence override removes instance without adding replacement", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "SUMMARY:Crossfit",
    "STATUS:CANCELLED",
    "DTSTART:20260703T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-29T00:00:00Z"),
    lookaheadHours: 120,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.deepEqual(events, []);
});

test("moved recurring override without summary inherits master summary", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "DTSTART:20260703T073000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-29T00:00:00Z"),
    lookaheadHours: 120,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.deepEqual(
    events.map((event) => [event.classDate, event.classTime, event.summary]),
    [["2026-07-03", "08:30", "Crossfit"]],
  );
});

test("cancelled recurrence override without summary still removes instance", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "STATUS:CANCELLED",
    "DTSTART:20260703T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-29T00:00:00Z"),
    lookaheadHours: 120,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.deepEqual(events, []);
});

test("cancelled recurrence override without dtstart still removes instance", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-29T00:00:00Z"),
    lookaheadHours: 120,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.deepEqual(events, []);
});

test("malformed recurrence-id on one override does not abort expansion", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:not-a-valid-date",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-29T00:00:00Z"),
    lookaheadHours: 120,
    calendarEventNames: ["Crossfit"],
    timeZone: "Europe/Lisbon",
  });

  assert.deepEqual(events, []);
});

test("buildPlan unenrolls cancelled recurring instance without new enroll", async () => {
  const staleKey = "regybox:v1:calendar:weekly-class:2026-07-03T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        staleKey,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-07-03",
          classTime: "06:30",
          classType: "WOD",
          calendarEventName: "Crossfit",
          calendarFingerprint: "weekly-class:2026-07-03T06:30:00.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "STATUS:CANCELLED",
    "DTSTART:20260703T053000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-30T12:00:00Z"),
  });

  assert.deepEqual(
    plan.dispatches.map((dispatch) => [
      dispatch.operation,
      dispatch.inputs["class-date"],
      dispatch.inputs["class-time"],
    ]),
    [["unenroll", "2026-07-03", "06:30"]],
  );
});

test("moved recurring instance dispatches enroll at new time and unenrolls stale slot", async () => {
  const staleKey = "regybox:v1:calendar:weekly-class:2026-07-03T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        staleKey,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-07-03",
          classTime: "06:30",
          classType: "WOD",
          calendarEventName: "Crossfit",
          calendarFingerprint: "weekly-class:2026-07-03T06:30:00.000Z",
        }),
      ],
    ]),
  );
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260626T053000Z",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "EXDATE:20260703T053000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-class",
    "RECURRENCE-ID:20260703T053000Z",
    "SUMMARY:Crossfit",
    "DTSTART:20260703T073000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: ics,
    now: new Date("2026-06-30T12:00:00Z"),
  });

  assert.deepEqual(
    plan.dispatches.map((dispatch) => [
      dispatch.operation,
      dispatch.inputs["class-date"],
      dispatch.inputs["class-time"],
    ]),
    [
      ["enroll", "2026-07-03", "08:30"],
      ["unenroll", "2026-07-03", "06:30"],
    ],
  );
});

test("unsupported monthly RRULEs are ignored", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:monthly-class",
    "SUMMARY:Crossfit",
    "DTSTART:20260618T063000Z",
    "RRULE:FREQ=MONTHLY;COUNT=3",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = expandCalendarEvents({
    icsText: ics,
    now: new Date("2026-06-18T00:00:00Z"),
    lookaheadHours: 72,
    calendarEventNames: ["Crossfit"],
  });

  assert.deepEqual(events, []);
});

test("past stale enrolled KV entries do not dispatch unenroll", async () => {
  const key = "regybox:v1:calendar:old-class:2026-06-17T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-06-17",
          classTime: "06:30",
          classType: "WOD",
          calendarFingerprint: "old-class:2026-06-17T06:30:00.000Z",
        }),
      ],
    ]),
  );

  const plan = await buildPlan({
    env: baseEnv,
    kv,
    icsText: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
    now: new Date("2026-06-18T00:00:00Z"),
  });

  assert.deepEqual(plan.dispatches, []);
});

test("missing calendar event names fail before stale KV sweep", async () => {
  const key = "regybox:v1:calendar:old-class:2026-06-18T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        key,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-06-18",
          classTime: "06:30",
          classType: "WOD",
          calendarFingerprint: "old-class:2026-06-18T06:30:00.000Z",
        }),
      ],
    ]),
  );

  await assert.rejects(
    () =>
      buildPlan({
        env: { ...baseEnv, CALENDAR_EVENT_NAMES: " , " },
        kv,
        icsText: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
        now: new Date("2026-06-18T00:00:00Z"),
      }),
    /CALENDAR_EVENT_NAMES/,
  );
});
