import assert from "node:assert/strict";
import test from "node:test";

import { buildPlan, parseClassMap, resolveClassRules } from "../src/index.js";

function makeKv(existing = new Map()) {
  return {
    async get(key) {
      return existing.get(key) ?? null;
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

function calendar(events) {
  return ["BEGIN:VCALENDAR", ...events, "END:VCALENDAR"].join("\r\n");
}

function event({ uid, summary, start }) {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    "END:VEVENT",
  ].join("\r\n");
}

test("parseClassMap normalizes whitespace and fallback class names", () => {
  assert.deepEqual(
    parseClassMap(" Weightlifting = Weightlifting Rato ; CrossFit = WOD,  Weekend WOD "),
    [
      { eventName: "Weightlifting", classType: "Weightlifting Rato" },
      { eventName: "CrossFit", classType: "WOD, Weekend WOD" },
    ],
  );
});

test("parseClassMap rejects malformed rules loudly", () => {
  assert.throws(() => parseClassMap("CrossFit WOD"), /CrossFit WOD/);
  assert.throws(() => parseClassMap(" = WOD"), /= WOD/);
  assert.throws(() => parseClassMap("CrossFit =  "), /CrossFit =/);
  assert.throws(() => parseClassMap("CrossFit = WOD; crossfit = Weekend WOD"), /crossfit/);
});

test("resolveClassRules prefers CLASS_MAP and preserves legacy validation", () => {
  assert.deepEqual(
    resolveClassRules({
      CLASS_MAP: "CrossFit = WOD",
      CALENDAR_EVENT_NAMES: "Ignored",
      CLASS_TYPE: "Ignored",
    }),
    [{ eventName: "CrossFit", classType: "WOD" }],
  );
  assert.deepEqual(
    resolveClassRules({ CALENDAR_EVENT_NAMES: "CrossFit, Weightlifting", CLASS_TYPE: "WOD" }),
    [
      { eventName: "CrossFit", classType: "WOD" },
      { eventName: "Weightlifting", classType: "WOD" },
    ],
  );
  assert.throws(
    () => resolveClassRules({ CALENDAR_EVENT_NAMES: " , ", CLASS_TYPE: "WOD" }),
    /CALENDAR_EVENT_NAMES/,
  );
});

test("CLASS_MAP matches event names case-insensitively and preserves per-event slot types", async () => {
  const now = new Date("2026-07-12T00:00:00Z");
  const weightliftingKey = "regybox:v1:calendar:weightlifting:2026-07-12T06:30:00.000Z";
  const kv = makeKv(
    new Map([
      [
        weightliftingKey,
        JSON.stringify({
          state: "enrolled",
          classDate: "2026-07-12",
          classTime: "06:30",
          classType: "Weightlifting Rato",
          calendarEventName: "weightlifting",
          calendarFingerprint: "weightlifting:2026-07-12T06:30:00.000Z",
        }),
      ],
    ]),
  );
  const env = {
    CLASS_MAP: "Weightlifting = Weightlifting Rato; CrossFit = WOD, Weekend WOD",
    TIMEZONE: "Europe/Lisbon",
  };
  const bothEvents = calendar([
    event({ uid: "weightlifting", summary: "weightlifting", start: "20260712T063000Z" }),
    event({ uid: "crossfit", summary: "CROSSFIT", start: "20260712T063000Z" }),
  ]);

  const enrollPlan = await buildPlan({ env, kv, icsText: bothEvents, now });
  assert.deepEqual(
    enrollPlan.events.map((item) => [item.summary, item.classType]),
    [
      ["weightlifting", "Weightlifting Rato"],
      ["CROSSFIT", "WOD, Weekend WOD"],
    ],
  );
  assert.deepEqual(enrollPlan.dispatches.map((item) => item.inputs["class-type"]), [
    "WOD, Weekend WOD",
  ]);

  const unenrollPlan = await buildPlan({
    env,
    kv,
    icsText: calendar([event({ uid: "crossfit", summary: "CROSSFIT", start: "20260712T063000Z" })]),
    now,
  });
  assert.deepEqual(unenrollPlan.dispatches.map((item) => item.inputs["class-type"]), [
    "WOD, Weekend WOD",
    "Weightlifting Rato",
  ]);
  assert.equal(unenrollPlan.dispatches[1].operation, "unenroll");
});
