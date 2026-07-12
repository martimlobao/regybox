import assert from "node:assert/strict";
import test from "node:test";

import { expandCalendarEvents } from "../src/calendar.js";

const NOW = new Date("2026-07-12T08:00:00Z");
const CLASS_RULES = [
  { eventName: "Folded WOD", classType: "Folded" },
  { eventName: "Float WOD", classType: "Float" },
  { eventName: "All Day WOD", classType: "All Day" },
  { eventName: "Recurring WOD", classType: "Recurring" },
  { eventName: "Override WOD", classType: "Override" },
];

function event({ uid, lines }) {
  return ["BEGIN:VEVENT", `UID:${uid}`, ...lines, "END:VEVENT"].join("\r\n");
}

function corpus() {
  const foldedDescription = [
    "DESCRIPTION:This deliberately long description is folded so the parser must join the ",
    " continuation line before it can finish reading this field.",
  ];
  return [
    "BEGIN:VCALENDAR",
    event({
      uid: "past-single",
      lines: ["DTSTART:20260101T063000Z", "SUMMARY:  Folded WOD  ", ...foldedDescription],
    }),
    event({
      uid: "folded-summary",
      lines: ["DTSTART:20260713T063000Z", "SUMMARY:  Folded ", " WOD  ", ...foldedDescription],
    }),
    event({
      uid: "floating-single",
      lines: ["DTSTART:20260714T071500", "SUMMARY:  float wod  ", ...foldedDescription],
    }),
    event({
      uid: "all-day",
      lines: ["DTSTART;VALUE=DATE:20260715", "SUMMARY:All Day WOD", ...foldedDescription],
    }),
    event({
      uid: "non-matching",
      lines: ["DTSTART:20260713T063000Z", "SUMMARY:Yoga", ...foldedDescription],
    }),
    event({
      uid: "weekly-count-until",
      lines: [
        "DTSTART:20250106T063000Z",
        "SUMMARY:Recurring WOD",
        "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=200;UNTIL=20260731T063000Z",
        "EXDATE:20260713T063000Z,20260715T063000Z",
        ...foldedDescription,
      ],
    }),
    event({
      uid: "weekly-overrides",
      lines: [
        "DTSTART:20250107T063000Z",
        "SUMMARY:Recurring WOD",
        "RRULE:FREQ=WEEKLY;COUNT=100;UNTIL=20261231T063000Z",
        ...foldedDescription,
      ],
    }),
    event({
      uid: "weekly-no-count",
      lines: [
        "DTSTART:20240101T063000Z",
        "SUMMARY:Recurring WOD",
        "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T063000Z",
        ...foldedDescription,
      ],
    }),
    event({
      uid: "weekly-overrides",
      lines: [
        "RECURRENCE-ID:20260714T063000Z",
        "DTSTART:20260716T083000Z",
        "SUMMARY: Override WOD ",
        ...foldedDescription,
      ],
    }),
    event({
      uid: "weekly-overrides",
      lines: [
        "RECURRENCE-ID:20260721T063000Z",
        "DTSTART:20260721T063000Z",
        "STATUS:CANCELLED",
        ...foldedDescription,
      ],
    }),
    "END:VCALENDAR",
  ].join("\r\n");
}

function snapshot(events) {
  return events.map(({ start, ...event }) => ({ ...event, start: start.toISOString() }));
}

test("expandCalendarEvents preserves the synthetic ICS parity contract", () => {
  const actual = snapshot(expandCalendarEvents({
    icsText: corpus(),
    now: NOW,
    lookaheadHours: 168,
    classRules: CLASS_RULES,
    timeZone: "Europe/Lisbon",
  }));

  assert.deepEqual(actual, [
    {
      summary: "  Folded WOD  ",
      uid: "folded-summary",
      start: "2026-07-13T06:30:00.000Z",
      classDate: "2026-07-13",
      classTime: "07:30",
      fingerprint: "folded-summary:2026-07-13T06:30:00.000Z",
      cacheKey: "regybox:v1:calendar:folded-summary:2026-07-13T06:30:00.000Z",
      classType: "Folded",
    },
    {
      summary: "Recurring WOD",
      uid: "weekly-no-count",
      start: "2026-07-13T06:30:00.000Z",
      classDate: "2026-07-13",
      classTime: "07:30",
      fingerprint: "weekly-no-count:2026-07-13T06:30:00.000Z",
      cacheKey: "regybox:v1:calendar:weekly-no-count:2026-07-13T06:30:00.000Z",
      classType: "Recurring",
    },
    {
      summary: "  float wod  ",
      uid: "floating-single",
      start: "2026-07-14T07:15:00.000Z",
      classDate: "2026-07-14",
      classTime: "07:15",
      fingerprint: "floating-single:2026-07-14T07:15:00.000Z",
      cacheKey: "regybox:v1:calendar:floating-single:2026-07-14T07:15:00.000Z",
      classType: "Float",
    },
    {
      summary: "All Day WOD",
      uid: "all-day",
      start: "2026-07-15T00:00:00.000Z",
      classDate: "2026-07-15",
      classTime: "00:00",
      fingerprint: "all-day:2026-07-15T00:00:00.000Z",
      cacheKey: "regybox:v1:calendar:all-day:2026-07-15T00:00:00.000Z",
      classType: "All Day",
    },
    {
      summary: "Recurring WOD",
      uid: "weekly-no-count",
      start: "2026-07-15T06:30:00.000Z",
      classDate: "2026-07-15",
      classTime: "07:30",
      fingerprint: "weekly-no-count:2026-07-15T06:30:00.000Z",
      cacheKey: "regybox:v1:calendar:weekly-no-count:2026-07-15T06:30:00.000Z",
      classType: "Recurring",
    },
    {
      summary: " Override WOD ",
      uid: "weekly-overrides",
      start: "2026-07-16T08:30:00.000Z",
      classDate: "2026-07-16",
      classTime: "09:30",
      fingerprint: "weekly-overrides:2026-07-16T08:30:00.000Z",
      cacheKey: "regybox:v1:calendar:weekly-overrides:2026-07-16T08:30:00.000Z",
      classType: "Override",
    },
  ]);
});

test("expandCalendarEvents preserves parameterized and folded SUMMARY values", () => {
  const actual = snapshot(expandCalendarEvents({
    icsText: [
      "BEGIN:VCALENDAR",
      event({
        uid: "summary-param",
        lines: ["DTSTART:20260713T063000Z", "SUMMARY;LANGUAGE=pt:  Param WOD  "],
      }),
      event({
        uid: "folded-summary-param",
        lines: [
          "DTSTART:20260714T063000Z",
          "SUMMARY;LANGUAGE=pt:  Folded Param ",
          " WOD  ",
        ],
      }),
      "END:VCALENDAR",
    ].join("\r\n"),
    now: NOW,
    lookaheadHours: 168,
    classRules: [
      { eventName: "Param WOD", classType: "Param" },
      { eventName: "Folded Param WOD", classType: "Folded Param" },
    ],
    timeZone: "Europe/Lisbon",
  }));

  assert.deepEqual(actual, [
    {
      summary: "  Param WOD  ",
      uid: "summary-param",
      start: "2026-07-13T06:30:00.000Z",
      classDate: "2026-07-13",
      classTime: "07:30",
      fingerprint: "summary-param:2026-07-13T06:30:00.000Z",
      cacheKey: "regybox:v1:calendar:summary-param:2026-07-13T06:30:00.000Z",
      classType: "Param",
    },
    {
      summary: "  Folded Param WOD  ",
      uid: "folded-summary-param",
      start: "2026-07-14T06:30:00.000Z",
      classDate: "2026-07-14",
      classTime: "07:30",
      fingerprint: "folded-summary-param:2026-07-14T06:30:00.000Z",
      cacheKey: "regybox:v1:calendar:folded-summary-param:2026-07-14T06:30:00.000Z",
      classType: "Folded Param",
    },
  ]);
});
