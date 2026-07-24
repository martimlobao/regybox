const KV_PREFIX = "regybox:v1:calendar:";
// Cron runs at :28 and :58. Refreshing after 5h30 ensures the first eligible
// cron is never later than six hours after the previous check.
const NOT_OPEN_REFRESH_MS = 5.5 * 60 * 60 * 1000;
const NOT_OPEN_DISPATCH_WINDOW_MS = 60 * 60 * 1000;

export function normalizeList(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseClassMap(value) {
  const rules = [];
  const eventNames = new Set();
  for (const rawRule of String(value ?? "").split(";")) {
    if (!rawRule.trim()) {
      continue;
    }
    const separator = rawRule.indexOf("=");
    const badRule = rawRule;
    if (separator === -1) {
      throw new Error(`Invalid CLASS_MAP rule "${badRule}": expected Event Name = Class Name.`);
    }
    const eventName = rawRule.slice(0, separator).trim();
    const classType = normalizeList(rawRule.slice(separator + 1)).join(", ");
    if (!eventName || !classType) {
      throw new Error(`Invalid CLASS_MAP rule "${badRule}": both event and class names are required.`);
    }
    const normalizedEventName = eventName.toLowerCase();
    if (eventNames.has(normalizedEventName)) {
      throw new Error(`Duplicate CLASS_MAP event name "${eventName}" in rule "${badRule}".`);
    }
    eventNames.add(normalizedEventName);
    rules.push({ eventName, classType });
  }
  if (rules.length === 0) {
    throw new Error("CLASS_MAP must include at least one Event Name = Class Name rule.");
  }
  return rules;
}

export function resolveClassRules(env) {
  if (String(env.CLASS_MAP ?? "").trim()) {
    return parseClassMap(env.CLASS_MAP);
  }
  const calendarEventNames = normalizeList(env.CALENDAR_EVENT_NAMES);
  validateCalendarEventNames(calendarEventNames);
  return calendarEventNames.map((eventName) => ({ eventName, classType: env.CLASS_TYPE }));
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
    const value = line.slice(index + 1);
    // iCalendar permits multiple EXDATE properties. Keep every value so one
    // later exclusion cannot silently restore an earlier cancelled instance.
    if (name === "EXDATE" && props[name] !== undefined) {
      props[name] = `${props[name]},${value}`;
      props[rawName] = props[name];
    } else {
      props[rawName] = value;
      props[name] = value;
    }
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

  if (count === null && interval > 0 && windowStart > start) {
    const elapsedDays = Math.floor((windowStart - start) / 86_400_000);
    if (freq === "WEEKLY" && byday !== null) {
      // A BYDAY rule still checks one day at a time, but we only need to scan
      // the relevant interval week (and its few weekdays), not every day since
      // a calendar's original series start.
      const elapsedWeeks = Math.floor(elapsedDays / 7);
      const firstRelevantWeek = Math.ceil(elapsedWeeks / interval) * interval;
      cursor = addDays(start, firstRelevantWeek * 7);
    } else {
      const steps = Math.floor(elapsedDays / stepDays);
      cursor = addDays(start, steps * stepDays);
    }
  }

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

function parseEventChunk(chunk) {
  const lines = unfoldLines(chunk);
  const begin = lines.indexOf("BEGIN:VEVENT");
  const end = lines.lastIndexOf("END:VEVENT");
  return begin === -1 || end === -1 ? null : parseProperties(lines.slice(begin + 1, end));
}

function lineEnd(text, from, end) {
  const newline = text.indexOf("\n", from);
  return newline === -1 || newline >= end ? end : newline;
}

function propertyValue(text, propertyName, begin, end) {
  const needle = `\n${propertyName}`;
  let from = begin;
  while (from < end) {
    const propertyStart = text.indexOf(needle, from);
    if (propertyStart === -1 || propertyStart >= end) {
      return null;
    }
    const nameEnd = propertyStart + needle.length;
    if (text[nameEnd] !== ":" && text[nameEnd] !== ";") {
      from = nameEnd;
      continue;
    }

    let propertyEnd = lineEnd(text, nameEnd, end);
    while (propertyEnd < end && (text[propertyEnd + 1] === " " || text[propertyEnd + 1] === "\t")) {
      propertyEnd = lineEnd(text, propertyEnd + 1, end);
    }
    const valueStart = text.indexOf(":", nameEnd);
    if (valueStart !== -1 && valueStart < propertyEnd) {
      return text.slice(valueStart + 1, propertyEnd).replace(/\r?\n[ \t]/g, "");
    }
    from = nameEnd;
  }
  return null;
}

function parseRelevantEvents(icsText, ruleNames, now) {
  const events = [];
  const text = String(icsText);
  let from = 0;
  let nextRecurrenceId = text.indexOf("RECURRENCE-ID", from);
  let nextRrule = text.indexOf("RRULE", from);
  while (from < text.length) {
    const begin = text.indexOf("BEGIN:VEVENT", from);
    if (begin === -1) {
      break;
    }
    const endMarker = text.indexOf("END:VEVENT", begin + "BEGIN:VEVENT".length);
    if (endMarker === -1) {
      break;
    }
    const end = endMarker + "END:VEVENT".length;

    // Google Calendar and the other iCalendar producers we support emit uppercase property names.
    // Reuse the next index so a dropped event never causes a scan of the remaining feed.
    if (nextRecurrenceId !== -1 && nextRecurrenceId < begin) {
      nextRecurrenceId = text.indexOf("RECURRENCE-ID", begin);
    }
    if (nextRrule !== -1 && nextRrule < begin) {
      nextRrule = text.indexOf("RRULE", begin);
    }
    const isOverride = nextRecurrenceId !== -1 && nextRecurrenceId < end;
    const isRecurring = nextRrule !== -1 && nextRrule < end;
    // Overrides are kept unconditionally (their SUMMARY may differ from the
    // master's; UID filtering happens after masters are known). Masters —
    // recurring or not — can only be tracked when their SUMMARY matches a
    // rule name, so anything else is dropped before the expensive parse.
    if (!isOverride) {
      const summary = propertyValue(text, "SUMMARY", begin, end);
      const hasTrackedName = summary !== null && ruleNames.includes(summary.trim().toLowerCase());
      if (!hasTrackedName) {
        from = end;
        if (isRecurring) {
          nextRrule = text.indexOf("RRULE", from);
        }
        continue;
      }
      if (!isRecurring) {
        const start = tryParseDate(propertyValue(text, "DTSTART", begin, end));
        if (start && start < now) {
          from = end;
          continue;
        }
      }
    }
    const props = parseEventChunk(text.slice(begin, end));
    if (props) {
      events.push(props);
    }
    from = end;
    if (isOverride) {
      nextRecurrenceId = text.indexOf("RECURRENCE-ID", from);
    }
    if (isRecurring) {
      nextRrule = text.indexOf("RRULE", from);
    }
  }
  return events;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function createZonedDateParts(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return (date) =>
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
}

function eventDetails(props, start, zonedDateParts, classType, summary = props.SUMMARY) {
  const uid = props.UID || `${summary}:${start.toISOString()}`;
  const fingerprint = `${uid}:${start.toISOString()}`;
  const isUtc = props.DTSTART.trim().endsWith("Z");
  const zoned = isUtc ? zonedDateParts(start) : null;
  return {
    summary,
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
    classType,
  };
}

function isCancelledEvent(props) {
  return String(props.STATUS ?? "").trim().toUpperCase() === "CANCELLED";
}

function recurrenceIdValue(props) {
  return props["RECURRENCE-ID"] ?? null;
}

function isRecurrenceOverride(props) {
  return recurrenceIdValue(props) !== null;
}

function classRuleForSummary(summary, rulesByEventName) {
  return rulesByEventName.get(String(summary ?? "").trim().toLowerCase()) ?? null;
}

function masterClassRule(props, rulesByEventName) {
  if (!props.DTSTART || !props.SUMMARY) {
    return null;
  }
  return classRuleForSummary(props.SUMMARY, rulesByEventName);
}

function tryParseDate(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = parseDate(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

function excludedRecurrenceInstants(overrides) {
  return overrides
    .map((props) => tryParseDate(recurrenceIdValue(props)))
    .filter((instant) => instant !== null);
}

function overrideStartInstant(props) {
  return tryParseDate(props.DTSTART);
}

function appendOverrideInstances({
  events,
  overrides,
  now,
  windowEnd,
  zonedDateParts,
  masterSummary,
  classRule,
  rulesByEventName,
}) {
  for (const props of overrides) {
    if (isCancelledEvent(props)) {
      continue;
    }
    const overrideStart = overrideStartInstant(props);
    if (!overrideStart) {
      continue;
    }
    // Match recurrenceInstances: only emit overrides inside the lookahead window.
    if (overrideStart >= now && overrideStart < windowEnd) {
      const summary = props.SUMMARY ?? masterSummary;
      events.push(
        eventDetails(
          props,
          overrideStart,
          zonedDateParts,
          classRuleForSummary(summary, rulesByEventName)?.classType ?? classRule.classType,
          summary,
        ),
      );
    }
  }
}

export function expandCalendarEvents({
  icsText,
  now,
  lookaheadHours,
  calendarEventNames,
  classRules,
  timeZone = "Europe/Lisbon",
}) {
  const resolvedRules = classRules ?? (calendarEventNames ?? []).map((eventName) => ({
    eventName,
    classType: undefined,
  }));
  validateCalendarEventNames(resolvedRules.map((rule) => rule.eventName));
  const rulesByEventName = new Map(
    resolvedRules.map((rule) => [rule.eventName.trim().toLowerCase(), rule]),
  );
  const ruleNames = [...rulesByEventName.keys()].filter(Boolean);
  const windowEnd = new Date(now.getTime() + lookaheadHours * 60 * 60 * 1000);
  const zonedDateParts = createZonedDateParts(timeZone);
  const overridesByUid = new Map();
  const masterEvents = [];

  for (const props of parseRelevantEvents(icsText, ruleNames, now)) {
    if (isRecurrenceOverride(props)) {
      const uid = props.UID;
      if (!uid) {
        continue;
      }
      const overrides = overridesByUid.get(uid) ?? [];
      overrides.push(props);
      overridesByUid.set(uid, overrides);
      continue;
    }
    const classRule = masterClassRule(props, rulesByEventName);
    if (classRule) {
      masterEvents.push({ props, classRule });
    }
  }

  const trackedUids = new Set(masterEvents.map(({ props }) => props.UID).filter(Boolean));
  for (const uid of overridesByUid.keys()) {
    if (!trackedUids.has(uid)) {
      overridesByUid.delete(uid);
    }
  }

  const events = [];
  for (const { props, classRule } of masterEvents) {
    const overrides = props.UID ? (overridesByUid.get(props.UID) ?? []) : [];
    if (props.UID) {
      overridesByUid.delete(props.UID);
    }
    const start = parseDate(props.DTSTART);
    const excludedDates = [
      ...parseDateList(props.EXDATE),
      ...excludedRecurrenceInstants(overrides),
    ];
    const starts = props.RRULE
      ? recurrenceInstances(start, parseRrule(props.RRULE), now, windowEnd, excludedDates)
      : [start].filter(
          (candidate) =>
            candidate >= now &&
            candidate < windowEnd &&
            !excludedDates.some((excluded) => sameUtcInstant(excluded, candidate)),
        );
    events.push(
      ...starts.map((instanceStart) =>
        eventDetails(props, instanceStart, zonedDateParts, classRule.classType),
      ),
    );
    appendOverrideInstances({
      events,
      overrides,
      now,
      windowEnd,
      zonedDateParts,
      masterSummary: props.SUMMARY,
      classRule,
      rulesByEventName,
    });
  }

  return events.sort((left, right) => left.start - right.start);
}

async function listKvEntries(kv) {
  if (typeof kv.list !== "function") {
    return [];
  }
  const keys = [];
  let cursor;
  do {
    const response = await kv.list({ prefix: KV_PREFIX, cursor });
    keys.push(...(response.keys ?? []));
    cursor = response.list_complete === false ? response.cursor : undefined;
  } while (cursor);
  return keys;
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

function classSlotKey(classDate, classTime, classType) {
  if (!classDate || !classTime || !classType) {
    return null;
  }
  return `${classDate}T${classTime}:${classType}`;
}

function eventSlotKey(event) {
  return classSlotKey(event.classDate, event.classTime, event.classType);
}

function cachedSlotKey(cached) {
  return classSlotKey(cached?.classDate, cached?.classTime, cached?.classType);
}

function parseOptionalDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function notOpenShouldDispatch(cached, now) {
  if (cached?.state !== "not_open") {
    return true;
  }
  const enrollmentOpensAt = parseOptionalDate(cached.enrollmentOpensAt);
  const lastCheckedAt = parseOptionalDate(cached.lastCheckedAt);
  if (!enrollmentOpensAt || !lastCheckedAt) {
    return true;
  }
  if (enrollmentOpensAt.getTime() - now.getTime() <= NOT_OPEN_DISPATCH_WINDOW_MS) {
    return true;
  }
  return now.getTime() - lastCheckedAt.getTime() >= NOT_OPEN_REFRESH_MS;
}

function dispatchPayload({ operation, event, cacheKey, cached }) {
  const classDate = event?.classDate ?? cached.classDate;
  const classTime = event?.classTime ?? cached.classTime;
  const classType = event ? event.classType : cached.classType;
  const fingerprint = event?.fingerprint ?? cached.calendarFingerprint ?? "";
  const calendarEventName = event?.summary ?? cached.calendarEventName ?? "";
  return {
    operation,
    inputs: {
      operation,
      "class-date": classDate,
      "class-time": classTime,
      "class-type": classType,
      "calendar-event-name": calendarEventName,
      "cache-key": cacheKey,
      "calendar-fingerprint": fingerprint,
    },
  };
}

export async function buildPlan({ env, kv, icsText, now = new Date(), onTrace = async () => {} }) {
  const lookaheadHours = defaultLookaheadHours(env);
  const classRules = resolveClassRules(env);
  const events = expandCalendarEvents({
    icsText,
    now,
    lookaheadHours,
    classRules,
    timeZone: env.TIMEZONE || "Europe/Lisbon",
  });
  await onTrace({
    scope: "calendar",
    code: "calendar_events_expanded",
    message: `Found ${events.length} relevant calendar event(s) in the scheduling window`,
    data: { eventCount: events.length },
  });
  const activeKeys = new Set(events.map((event) => event.cacheKey));
  const activeSlots = new Set(events.map((event) => eventSlotKey(event)).filter(Boolean));
  const dispatches = [];
  const kvEntries = await listKvEntries(kv);
  const cachedKvEntries = await Promise.all(
    kvEntries.map(async ({ name }) => [name, await readJson(kv, name)]),
  );
  const cachedByName = new Map(cachedKvEntries);
  const enrolledSlots = new Set(
    cachedKvEntries
      .filter(([, cached]) => cached?.state === "enrolled" && cachedEventIsFuture(cached, now))
      .map(([, cached]) => cachedSlotKey(cached))
      .filter(Boolean),
  );

  const eventCacheEntries = await Promise.all(
    events.map(async (event) => [
      event,
      cachedByName.has(event.cacheKey)
        ? cachedByName.get(event.cacheKey)
        : await readJson(kv, event.cacheKey),
    ]),
  );
  const plannedEnrollmentSlots = new Set();

  for (const [event, cached] of eventCacheEntries) {
    const slotKey = eventSlotKey(event);
    const cacheAgeMs = cached?.lastCheckedAt
      ? now.getTime() - (parseOptionalDate(cached.lastCheckedAt)?.getTime() ?? now.getTime())
      : null;
    const refreshDueAt = cached?.lastCheckedAt
      ? new Date(
          (parseOptionalDate(cached.lastCheckedAt)?.getTime() ?? now.getTime()) +
            NOT_OPEN_REFRESH_MS,
        ).toISOString()
      : null;
    const openingAt = parseOptionalDate(cached?.enrollmentOpensAt);
    const refreshDue = cached?.state === "not_open" && cacheAgeMs >= NOT_OPEN_REFRESH_MS;
    const openingDueSoon = cached?.state === "not_open" && openingAt &&
      openingAt.getTime() - now.getTime() <= NOT_OPEN_DISPATCH_WINDOW_MS;
    const shouldDispatch =
      (!cached || (cached.state !== "enrolled" && notOpenShouldDispatch(cached, now))) &&
      !enrolledSlots.has(slotKey) &&
      !plannedEnrollmentSlots.has(slotKey);
    let reason;
    if (!cached) reason = "no_cached_state";
    else if (cached.state === "enrolled" || enrolledSlots.has(slotKey)) reason = "already_enrolled";
    else if (plannedEnrollmentSlots.has(slotKey)) reason = "duplicate_slot";
    else if (refreshDue) reason = "forced_refresh_due";
    else if (openingDueSoon) reason = "opening_within_dispatch_window";
    else if (cached.state === "not_open") reason = "cached_not_open_not_due";
    else reason = "state_requires_check";
    const ageText = Number.isFinite(cacheAgeMs)
      ? `${Math.floor(cacheAgeMs / 3_600_000)}h${String(Math.floor((cacheAgeMs % 3_600_000) / 60_000)).padStart(2, "0")}m`
      : null;
    await onTrace({
      scope: "calendar",
      code: shouldDispatch ? "calendar_event_scheduled" : "calendar_event_skipped",
      message: refreshDue
        ? `Cached not_open is ${ageText} old; forced refresh is due`
        : shouldDispatch
          ? `Scheduled enrollment check for ${event.classType} on ${event.classDate} at ${event.classTime}`
          : `Skipped ${event.classType} on ${event.classDate} at ${event.classTime} (${reason})`,
      data: {
        classDate: event.classDate,
        classTime: event.classTime,
        classType: event.classType,
        cacheState: cached?.state,
        cacheAgeMs,
        enrollmentOpensAt: cached?.enrollmentOpensAt,
        refreshDueAt,
        decision: shouldDispatch ? "dispatch" : "skip",
        reason,
      },
    });
    if (shouldDispatch) {
      dispatches.push(
        dispatchPayload({
          operation: "enroll",
          event,
          cacheKey: event.cacheKey,
          cached: {},
        }),
      );
      plannedEnrollmentSlots.add(slotKey);
    }
  }

  for (const [name, cached] of cachedKvEntries) {
    if (
      !activeKeys.has(name) &&
      !activeSlots.has(cachedSlotKey(cached)) &&
      cached?.state === "enrolled" &&
      cachedEventIsFuture(cached, now)
    ) {
      dispatches.push(
        dispatchPayload({
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
