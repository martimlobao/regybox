const KV_PREFIX = "regybox:v1:calendar:";

export function normalizeList(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function defaultLookaheadHours(env) {
  const parsed = Number.parseInt(env.LOOKAHEAD_HOURS ?? "73", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 73;
}

function unfoldLines(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const unfolded = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function parseDate(value) {
  const clean = value.trim();
  const match = clean.match(
    /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/,
  );
  if (!match) {
    throw new Error(`Unsupported iCalendar date: ${value}`);
  }
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return new Date(
    Date.UTC(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
    ),
  );
}

function parseProperties(lines) {
  const props = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index < 0) {
      continue;
    }
    const [rawName, ...params] = line.slice(0, index).split(";");
    const name = rawName.toUpperCase();
    props[rawName] = line.slice(index + 1);
    props[name] = line.slice(index + 1);
    props[`${name}_PARAMS`] = params;
  }
  return props;
}

function parseRrule(value) {
  return Object.fromEntries(
    String(value)
      .split(";")
      .map((part) => part.split("="))
      .filter(([key, val]) => key && val)
      .map(([key, val]) => [key.toUpperCase(), val]),
  );
}

function parseDateList(value) {
  return String(value ?? "")
    .split(",")
    .filter(Boolean)
    .map((part) => parseDate(part));
}

function sameUtcInstant(left, right) {
  return left.getTime() === right.getTime();
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function weekdayCode(date) {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][date.getUTCDay()];
}

function validateCalendarEventNames(calendarEventNames) {
  if (!Array.isArray(calendarEventNames) || calendarEventNames.length === 0) {
    throw new Error("CALENDAR_EVENT_NAMES must include at least one calendar event name.");
  }
}

function recurrenceInstances(start, rrule, windowStart, windowEnd, excludedDates = []) {
  const freq = rrule.FREQ;
  if (!["DAILY", "WEEKLY"].includes(freq)) {
    return [];
  }
  const interval = Number.parseInt(rrule.INTERVAL ?? "1", 10);
  const count = rrule.COUNT ? Number.parseInt(rrule.COUNT, 10) : null;
  const until = rrule.UNTIL ? parseDate(rrule.UNTIL) : null;
  const byday = rrule.BYDAY ? rrule.BYDAY.split(",") : null;
  const startWeekday = weekdayCode(start);
  const instances = [];
  let cursor = new Date(start);
  let generated = 0;
  const stepDays = freq === "WEEKLY" ? (byday === null ? 7 * interval : 1) : interval;
  const maxIterations = 4000;

  for (let index = 0; index < maxIterations; index += 1) {
    const dayOffset = Math.floor((cursor - start) / 86_400_000);
    const intervalMatch =
      freq === "WEEKLY" ? Math.floor(dayOffset / 7) % interval === 0 : true;
    const cursorWeekday = weekdayCode(cursor);
    const bydayMatch =
      byday === null
        ? freq !== "WEEKLY" || cursorWeekday === startWeekday
        : byday.includes(cursorWeekday);
    if (intervalMatch && bydayMatch) {
      generated += 1;
      if (
        (!until || cursor <= until) &&
        cursor >= windowStart &&
        cursor < windowEnd &&
        !excludedDates.some((excluded) => sameUtcInstant(excluded, cursor))
      ) {
        instances.push(new Date(cursor));
      }
      if (count !== null && generated >= count) {
        break;
      }
    }
    if (until && cursor > until) {
      break;
    }
    if (cursor >= windowEnd && (!count || generated >= count || start < windowEnd)) {
      if (cursor > windowEnd) {
        break;
      }
    }
    cursor = addDays(cursor, stepDays);
  }
  return instances;
}

function parseEvents(icsText) {
  const lines = unfoldLines(icsText);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = [];
    } else if (line === "END:VEVENT" && current) {
      events.push(parseProperties(current));
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  return events;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function zonedDateParts(date, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function eventDetails(props, start, timeZone) {
  const uid = props.UID || `${props.SUMMARY}:${start.toISOString()}`;
  const fingerprint = `${uid}:${start.toISOString()}`;
  const isUtc = props.DTSTART.trim().endsWith("Z");
  const zoned = isUtc ? zonedDateParts(start, timeZone) : null;
  return {
    summary: props.SUMMARY,
    uid,
    start,
    classDate: zoned
      ? `${zoned.year}-${zoned.month}-${zoned.day}`
      : `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`,
    classTime: zoned
      ? `${zoned.hour}:${zoned.minute}`
      : `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())}`,
    fingerprint,
    cacheKey: `${KV_PREFIX}${fingerprint}`,
  };
}

export function expandCalendarEvents({
  icsText,
  now,
  lookaheadHours,
  calendarEventNames,
  timeZone = "Europe/Lisbon",
}) {
  validateCalendarEventNames(calendarEventNames);
  const normalizedNames = new Set(calendarEventNames.map((name) => name.toLowerCase()));
  const windowEnd = new Date(now.getTime() + lookaheadHours * 60 * 60 * 1000);
  const events = [];
  for (const props of parseEvents(icsText)) {
    if (!props.DTSTART || !props.SUMMARY) {
      continue;
    }
    if (!normalizedNames.has(props.SUMMARY.trim().toLowerCase())) {
      continue;
    }
    const start = parseDate(props.DTSTART);
    const excludedDates = parseDateList(props.EXDATE);
    const starts = props.RRULE
      ? recurrenceInstances(start, parseRrule(props.RRULE), now, windowEnd, excludedDates)
      : [start].filter(
          (candidate) =>
            candidate >= now &&
            candidate < windowEnd &&
            !excludedDates.some((excluded) => sameUtcInstant(excluded, candidate)),
        );
    events.push(
      ...starts.map((instanceStart) => eventDetails(props, instanceStart, timeZone)),
    );
  }
  return events.sort((left, right) => left.start - right.start);
}

async function listKvEntries(kv) {
  if (typeof kv.list !== "function") {
    return [];
  }
  const response = await kv.list({ prefix: KV_PREFIX });
  return response.keys ?? [];
}

async function readJson(kv, key) {
  const raw = await kv.get(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cachedEventIsFuture(cached, now) {
  if (!cached?.classDate || !cached?.classTime) {
    return true;
  }
  return new Date(`${cached.classDate}T${cached.classTime}:00Z`) >= now;
}

function dispatchPayload({ env, operation, event, cacheKey, cached }) {
  const classDate = event?.classDate ?? cached.classDate;
  const classTime = event?.classTime ?? cached.classTime;
  const classType = env.CLASS_TYPE || cached.classType;
  const fingerprint = event?.fingerprint ?? cached.calendarFingerprint ?? "";
  return {
    operation,
    inputs: {
      operation,
      "class-date": classDate,
      "class-time": classTime,
      "class-type": classType,
      "cache-key": cacheKey,
      "calendar-fingerprint": fingerprint,
    },
  };
}

export async function buildPlan({ env, kv, icsText, now = new Date() }) {
  const lookaheadHours = defaultLookaheadHours(env);
  const calendarEventNames = normalizeList(env.CALENDAR_EVENT_NAMES);
  validateCalendarEventNames(calendarEventNames);
  const events = expandCalendarEvents({
    icsText,
    now,
    lookaheadHours,
    calendarEventNames,
    timeZone: env.TIMEZONE || "Europe/Lisbon",
  });
  const activeKeys = new Set(events.map((event) => event.cacheKey));
  const dispatches = [];

  const eventCacheEntries = await Promise.all(
    events.map(async (event) => [event, await readJson(kv, event.cacheKey)]),
  );

  for (const [event, cached] of eventCacheEntries) {
    if (!cached || cached.state !== "enrolled") {
      dispatches.push(
        dispatchPayload({
          env,
          operation: "enroll",
          event,
          cacheKey: event.cacheKey,
          cached: {},
        }),
      );
    }
  }

  const staleKvEntries = (await listKvEntries(kv)).filter(({ name }) => !activeKeys.has(name));
  const staleCacheEntries = await Promise.all(
    staleKvEntries.map(async ({ name }) => [name, await readJson(kv, name)]),
  );

  for (const [name, cached] of staleCacheEntries) {
    if (cached?.state === "enrolled" && cachedEventIsFuture(cached, now)) {
      dispatches.push(
        dispatchPayload({
          env,
          operation: "unenroll",
          event: null,
          cacheKey: name,
          cached,
        }),
      );
    }
  }
  return { dispatches, events };
}

async function dispatchWorkflow(env, dispatch) {
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "regybox-cloudflare-scheduler",
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || "main",
      inputs: dispatch.inputs,
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub dispatch failed: ${response.status} ${await response.text()}`);
  }
}

async function handleScheduled(env) {
  const calendarResponse = await fetch(env.CALENDAR_URL);
  if (!calendarResponse.ok) {
    throw new Error(`Calendar fetch failed: ${calendarResponse.status}`);
  }
  const plan = await buildPlan({
    env,
    kv: env.REGYBOX_STATE,
    icsText: await calendarResponse.text(),
  });
  for (const dispatch of plan.dispatches) {
    await dispatchWorkflow(env, dispatch);
  }
  return plan.dispatches.length;
}

export default {
  async scheduled(_event, env, _ctx) {
    await handleScheduled(env);
  },
  async fetch(_request, _env, _ctx) {
    return new Response("Regybox scheduler Worker is healthy.\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
