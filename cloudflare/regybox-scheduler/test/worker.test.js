import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
} from "../worker.js";

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
  return {
    writes,
    async get(key) {
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

test("default lookahead is 72 hours", () => {
  assert.equal(defaultLookaheadHours({}), 72);
  assert.equal(defaultLookaheadHours({ LOOKAHEAD_HOURS: "96" }), 96);
});

test("normalizeList accepts comma-separated values", () => {
  assert.deepEqual(normalizeList(" Crossfit, Strength ,, "), ["Crossfit", "Strength"]);
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
  assert.equal(plan.dispatches[0].inputs["class-date"], "2026-06-18");
  assert.equal(plan.dispatches[0].inputs["class-time"], "06:30");
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
