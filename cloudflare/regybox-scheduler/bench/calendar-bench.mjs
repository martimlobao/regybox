import { performance } from "node:perf_hooks";

const calendarModule = await import(process.env.CALENDAR_BENCH_IMPL ?? "../src/calendar.js");
const { expandCalendarEvents } = calendarModule;

const NOW = new Date("2026-07-12T08:00:00Z");
const CLASS_RULES = [
  { eventName: "Gym WOD", classType: "WOD" },
  { eventName: "Strength", classType: "Strength" },
];
const FOLDED_DESCRIPTION = [
  "DESCRIPTION:This synthetic description is intentionally long enough to make the feed resemble ",
  ` a Google Calendar export and it stays folded across every generated event for parser coverage. ${"calendar metadata ".repeat(2)}`,
  ` ${"additional folded details ".repeat(14)}`,
];

function event(uid, lines) {
  return ["BEGIN:VEVENT", `UID:${uid}`, ...lines, "END:VEVENT"].join("\r\n");
}

function buildFeed() {
  const events = ["BEGIN:VCALENDAR"];
  const pastStart = Date.UTC(2022, 0, 1, 6, 30);
  for (let index = 0; index < 1500; index += 1) {
    const date = new Date(pastStart + index * 86_400_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");
    events.push(event(`past-${index}`, [`DTSTART:${date}`, "SUMMARY:Gym WOD", ...FOLDED_DESCRIPTION]));
  }
  for (let index = 0; index < 120; index += 1) {
    events.push(event(`recurring-${index}`, [
      `DTSTART:202501${String((index % 28) + 1).padStart(2, "0")}T063000Z`,
      `SUMMARY:${index % 2 === 0 ? "Gym WOD" : "Strength"}`,
      "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;UNTIL=20271231T063000Z",
      ...FOLDED_DESCRIPTION,
    ]));
  }
  for (let index = 0; index < 50; index += 1) {
    const date = new Date(Date.UTC(2026, 6, 13 + (index % 6), 6, 30)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");
    events.push(event(`future-${index}`, [`DTSTART:${date}`, "SUMMARY:Gym WOD", ...FOLDED_DESCRIPTION]));
  }
  events.push("END:VCALENDAR");
  return events.join("\r\n");
}

const icsText = buildFeed();
const runs = 20;
for (let index = 0; index < 3; index += 1) {
  expandCalendarEvents({ icsText, now: NOW, lookaheadHours: 73, classRules: CLASS_RULES });
}
const started = performance.now();
for (let index = 0; index < runs; index += 1) {
  expandCalendarEvents({ icsText, now: NOW, lookaheadHours: 73, classRules: CLASS_RULES });
}
const averageMs = (performance.now() - started) / runs;
console.log(`feed bytes: ${Buffer.byteLength(icsText)}, events: 1670`);
console.log(`expandCalendarEvents average (${runs} runs): ${averageMs.toFixed(2)} ms`);
