const DOMAIN = "https://www.regybox.pt/app/app_nova/";
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DIV_TAG_RE = /<\/?div\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const BUTTON_RE = /<button\b([^>]*)>/i;
const INPUT_RE = /<input\b([^>]*)>/gi;

export class RegyboxLoginError extends Error {
  constructor(message = "Unable to log in") {
    super(message);
    this.name = "RegyboxLoginError";
  }
}

export class ClassNotFoundError extends Error {
  constructor({ classType = "", classTime = "", classDate = "" } = {}) {
    super(`Unable to find class '${classType}' at ${classTime} on ${classDate}`);
    this.name = "ClassNotFoundError";
  }
}

export class ClassNotOpenError extends Error {
  constructor(message = "Class is not open for enrollment") {
    super(message);
    this.name = "ClassNotOpenError";
  }
}

export class ClassIsOverbookedError extends Error {
  constructor(message = "Class is overbooked") {
    super(message);
    this.name = "ClassIsOverbookedError";
  }
}

export class UserAlreadyEnrolledError extends Error {
  constructor(message = "User already enrolled in class") {
    super(message);
    this.name = "UserAlreadyEnrolledError";
  }
}

export class RegyboxTimeoutError extends Error {
  constructor(timeoutSeconds, { timeToEnroll } = {}) {
    super(
      timeToEnroll === undefined
        ? `Timed out waiting for enrollment to open after ${timeoutSeconds} seconds`
        : `Enrollment opens in ${timeToEnroll} seconds, which exceeds ${timeoutSeconds} seconds`,
    );
    this.name = "RegyboxTimeoutError";
  }
}

export class UnparseableError extends Error {
  constructor(message = "Unable to parse HTML") {
    super(message);
    this.name = "UnparseableError";
  }
}

export class NoClassesFoundError extends Error {
  constructor(classDate = "") {
    super(`No classes found on ${classDate}`);
    this.name = "NoClassesFoundError";
  }
}

function parseAttributes(raw) {
  const attrs = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    if (name) {
      attrs[name.toLowerCase()] = decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? "");
    }
  }
  return attrs;
}

function classTokens(attrs) {
  return String(attrs.class ?? "").split(/\s+/).filter(Boolean);
}

function hasClass(attrs, ...names) {
  const tokens = new Set(classTokens(attrs));
  return names.every((name) => tokens.has(name));
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => {
      const number = value.toLowerCase().startsWith("x")
        ? Number.parseInt(value.slice(1), 16)
        : Number.parseInt(value, 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _;
    });
}

function fixText(value) {
  const text = String(value).trim().replace(/\s+/g, " ");
  // Regybox occasionally returns UTF-8 decoded as Windows-1252. This tiny
  // repair covers the fixture and action-response cases without vendoring ftfy.
  if (!/[ÃÂâ]/.test(text) || [...text].some((character) => character.codePointAt(0) > 255)) {
    return text;
  }
  try {
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from([...text], (character) => character.charCodeAt(0)),
    );
    return repaired.includes("�") ? text : repaired;
  } catch {
    return text;
  }
}

function textContent(html) {
  return fixText(decodeEntities(String(html).replace(TAG_RE, " ")));
}

function divNodes(html) {
  const nodes = [];
  const stack = [];
  for (const match of html.matchAll(DIV_TAG_RE)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      const node = stack.pop();
      if (node) {
        node.inner = html.slice(node.openEnd, match.index);
        node.end = match.index + tag.length;
        nodes.push(node);
      }
    } else {
      const attrs = parseAttributes(tag.slice(4, -1));
      stack.push({ attrs, start: match.index, openEnd: match.index + tag.length, inner: "", end: null });
    }
  }
  return nodes.sort((left, right) => left.start - right.start);
}

function classBlocks(html) {
  return divNodes(html)
    .filter((node) => hasClass(node.attrs, "filtro0"))
    .map((node) => html.slice(node.start, node.end));
}

function findDiv(nodes, predicate) {
  return nodes.find((node) => predicate(node.attrs, node.inner));
}

function findLastDiv(nodes, predicate) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (predicate(nodes[index].attrs, nodes[index].inner)) {
      return nodes[index];
    }
  }
  return undefined;
}

function hasStyle(attrs, pattern) {
  return pattern.test(String(attrs.style ?? ""));
}

function buttonUrl(block, expectedClasses) {
  const match = block.match(BUTTON_RE);
  if (!match) {
    return null;
  }
  const attrs = parseAttributes(match[1]);
  if (!hasClass(attrs, ...expectedClasses)) {
    return null;
  }
  const urls = String(attrs.onclick ?? "").match(/[^'"\s]+\.php[^'"\s]*/g) ?? [];
  if (urls.length !== 1) {
    throw new UnparseableError(`Expected one action URL in button, found ${urls.length}`);
  }
  return new URL(decodeEntities(urls[0]), DOMAIN).href;
}

function firstButtonAttrs(block) {
  const match = block.match(BUTTON_RE);
  return match ? parseAttributes(match[1]) : null;
}

function timerValue(block) {
  for (const match of block.matchAll(INPUT_RE)) {
    const attrs = parseAttributes(match[1]);
    if (hasClass(attrs, "timers")) {
      const value = Number.parseInt(attrs.value, 10);
      if (!Number.isFinite(value)) {
        throw new UnparseableError(`Unexpected timer value: ${attrs.value}`);
      }
      return value;
    }
  }
  return null;
}

function zonedDate(epochSeconds, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date(epochSeconds * 1000))
    .filter((part) => part.type !== "literal");
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function parseClassBlock(block, { timezone }) {
  const rootMatch = block.match(/^<div\b([^>]*)>/i);
  const rootAttrs = rootMatch ? parseAttributes(rootMatch[1]) : null;
  const timestamp = String(rootAttrs?.id ?? "").match(/^feed_time_slot(\d+)$/);
  if (!timestamp) {
    throw new UnparseableError("Missing class timestamp");
  }
  const nodes = divNodes(block);
  const leftHalf = nodes.filter(
    (node) => node.attrs.align === "left" && hasClass(node.attrs, "col-50"),
  );
  if (leftHalf.length === 0) {
    throw new UnparseableError("Missing class name");
  }
  const rightHalf = nodes.find(
    (node) => node.attrs.align === "right" && hasClass(node.attrs, "col-50"),
  );
  const timeNode = findDiv(
    nodes,
    (attrs, inner) =>
      attrs.align === "left" &&
      hasClass(attrs, "col") &&
      /\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/.test(textContent(inner)),
  );
  const capacityNode = findDiv(
    nodes,
    (attrs, inner) =>
      attrs.align === "center" && hasClass(attrs, "col") && /\S+\s+(?:of|de)\s+\S+/i.test(textContent(inner)),
  );
  if (!rightHalf || !timeNode || !capacityNode) {
    throw new UnparseableError("Missing class fields");
  }
  const time = textContent(timeNode.inner).match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  const capacity = textContent(capacityNode.inner).match(/^(\S+)\s+(?:of|de)\s+(\S+)$/i);
  if (!time || !capacity) {
    throw new UnparseableError("Unexpected time or capacity format");
  }
  const curCapacity = parseCapacity(capacity[1]);
  if (curCapacity === null) {
    throw new UnparseableError(`Unexpected capacity value: ${capacity[1]}`);
  }
  const maxCapacity = parseCapacity(capacity[2]);
  const button = firstButtonAttrs(block);
  const isOpenByOtherEnrollment = nodes.some(
    (node) => hasClass(node.attrs, "letra_10") && hasStyle(node.attrs, /padding-top:\s*7px/i),
  );
  const isOpen = Boolean(button) || isOpenByOtherEnrollment;
  const enrolledStatus = nodes.some(
    (node) =>
      node.attrs.align === "right" &&
      hasClass(node.attrs, "ok_color") &&
      hasStyle(node.attrs, /padding-top:\s*1px/i),
  );
  let userIsEnrolled = enrolledStatus;
  let enrollUrl = null;
  let unenrollUrl = null;
  if (!enrolledStatus && button) {
    if (hasClass(button, "color-red")) {
      userIsEnrolled = true;
      unenrollUrl = buttonUrl(block, ["color-red"]);
    } else if (hasClass(button, "buts_inscrever", "color-green")) {
      enrollUrl = buttonUrl(block, ["buts_inscrever", "color-green"]);
    } else {
      throw new UnparseableError(`Unexpected button classes: ${button.class ?? ""}`);
    }
  }
  const error = /<span\b[^>]*\bclass\s*=\s*(["'])[^"']*\berro_color\b[^"']*\1/i.test(block);
  const userIsWaitlisted = nodes.some((node) => hasClass(node.attrs, "preloader", "color-orange"));
  const isFull = maxCapacity === null ? false : curCapacity >= maxCapacity;
  const isOverbooked = isFull && error;
  const enrollmentDeadlineExpired = error && !isFull;
  let userIsBlocked = !isOpen && !userIsEnrolled;
  let isOver = false;
  const state = findLastDiv(
    nodes,
    (attrs) => attrs.align === "right" && hasClass(attrs, "col"),
  );
  if (!state) {
    throw new UnparseableError("Missing class state");
  }
  if (/<span\b[^>]*\bclass\s*=\s*(["'])[^"']*\berro_color\b[^"']*\1/i.test(state.inner)) {
    userIsBlocked = true;
  } else {
    const stateChild = findDiv(
      divNodes(state.inner),
      (attrs) => hasStyle(attrs, /padding-top:\s*7px/i),
    );
    if (stateChild) {
      if (userIsWaitlisted) {
        isOver = false;
      } else if (!stateChild.attrs.class) {
        isOver = true;
      } else if (hasClass(stateChild.attrs, "letra_10")) {
        userIsBlocked = true;
      }
    }
  }
  const timer = timerValue(block);
  return {
    name: textContent(leftHalf[0].inner),
    details: textContent(rightHalf.inner),
    date: zonedDate(Number.parseInt(timestamp[1], 10), timezone),
    start: time[1],
    end: time[2],
    maxCapacity,
    curCapacity,
    isOpen,
    isFull,
    isOverbooked,
    enrollmentDeadlineExpired,
    isOver,
    userIsBlocked,
    userIsEnrolled,
    userIsWaitlisted,
    timeToStart: isOpen && !userIsEnrolled ? timer : null,
    timeToEnroll: !isOpen ? timer : null,
    enrollUrl,
    unenrollUrl,
  };
}

export function parseCapacity(value) {
  const normalized = String(value).trim();
  if (normalized === "∞") {
    return null;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new UnparseableError(`Unexpected capacity value: ${value}`);
  }
  return Number.parseInt(normalized, 10);
}

export function parseClasses(html, { date, timezone = "Europe/Lisbon" } = {}) {
  void date; // The timestamp embedded in each card is the Python source of truth.
  return classBlocks(String(html)).map((block) => parseClassBlock(block, { timezone }));
}

export function parseClass(html, { timezone = "Europe/Lisbon" } = {}) {
  return parseClassBlock(String(html), { timezone });
}

export function pickClass(classes, { classTime, classType, classDate }) {
  const selected = classes.find(
    (class_) =>
      class_.start === classTime &&
      class_.name.toUpperCase() === String(classType).toUpperCase() &&
      class_.date === classDate,
  );
  if (!selected) {
    throw new ClassNotFoundError({ classType, classTime, classDate });
  }
  return selected;
}

export function parseClassTypes(classTypes) {
  return String(classTypes ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function pickFirstClass(classes, { classTime, classTypes, classDate }) {
  const candidates = Array.isArray(classTypes) ? classTypes : parseClassTypes(classTypes);
  let lastError;
  for (const classType of candidates) {
    try {
      return pickClass(classes, { classTime, classType, classDate });
    } catch (error) {
      if (!(error instanceof ClassNotFoundError)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError ?? new ClassNotFoundError({ classTime, classDate });
}

export function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function actionResponse(html, { enroll }) {
  const scripts = [...String(html).matchAll(SCRIPT_RE)].map((match) => match[1]);
  const responseScript = scripts.find((script) => script.includes("msg_toast_icon"));
  if (!responseScript) {
    throw new UnparseableError("Couldn't parse Regybox action response");
  }
  const messages = [...responseScript.matchAll(/parent\.msg_toast_icon\s*\(\s*["'](.+?)["']\s*,/g)].map(
    (match) => fixText(decodeEntities(match[1])),
  );
  if (messages.length !== 1) {
    throw new UnparseableError("Couldn't parse Regybox action response");
  }
  const message = messages[0];
  if (enroll && /already\s+(?:enrolled|registered)|j[áa].*(?:inscrit|registad)/i.test(message)) {
    throw new UserAlreadyEnrolledError(message);
  }
  return {
    message,
    userIsWaitlisted:
      enroll && scripts.some((script) => /parent\.popup\('\s*php\/popups\/lista_espera\.php/i.test(script)),
  };
}

export function createRegyboxClient({
  phpsessid,
  regyboxUser,
  fetchImpl = fetch,
  timezone = "Europe/Lisbon",
  retryTotal = 4,
  retryBackoffMs = 50,
  sleep = defaultSleep,
} = {}) {
  if (!phpsessid || !regyboxUser) {
    throw new Error("phpsessid and regyboxUser are required");
  }
  const headers = {
    Accept: "text/html, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: `PHPSESSID=${phpsessid}; regybox_boxes=%2A${regyboxUser}; regybox_user=${regyboxUser}`,
    DNT: "1",
    Referer: DOMAIN,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
  };

  async function getHtml(path, params = {}) {
    const url = new URL(path, DOMAIN);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    let response;
    for (let attempt = 0; attempt <= retryTotal; attempt += 1) {
      try {
        response = await fetchImpl(url.href, { headers, method: "GET" });
      } catch (error) {
        if (attempt === retryTotal) {
          throw error;
        }
        await sleep(retryBackoffMs * 2 ** attempt);
        continue;
      }
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === retryTotal) {
        break;
      }
      await sleep(retryBackoffMs * 2 ** attempt);
    }
    if (!response?.ok) {
      throw new Error(`Regybox request failed with HTTP ${response?.status ?? "unknown"}`);
    }
    const html = await response.text();
    if (/app\/app_nova\/login\.php/.test(html)) {
      throw new RegyboxLoginError();
    }
    return html;
  }

  return {
    headers: { ...headers },
    timezone,
    bootstrapSession: () =>
      getHtml("set_session.php", {
        z: regyboxUser,
        y: `*${regyboxUser}`,
        ignore: "regybox.pt/app/app",
      }),
    fetchClassesHtml: (timestampMs) =>
      getHtml("php/aulas/aulas.php", {
        valor1: String(timestampMs),
        type: "",
        source: "mes",
        scroll: "s",
        box: "",
        plano: "0",
        z: regyboxUser,
      }),
    async enroll(url) {
      return actionResponse(await getHtml(url), { enroll: true });
    },
    async unenroll(url) {
      return actionResponse(await getHtml(url), { enroll: false });
    },
  };
}

function zonedMidnightMs(date, timezone) {
  const [year, month, day] = String(date).split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid classDate: ${date}`);
  }
  const guess = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(guess))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - guess;
  return guess - offset;
}

function zonedIso(timestampMs, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  const offsetMinutes = Math.round((localAsUtc - timestampMs) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function operationResult(operation, status, classType, extra = {}) {
  return { operation, status, classType, ...extra };
}

function closedResult({ classType, timeToEnroll, now, timezone }) {
  const lastCheckedAt = zonedIso(now, timezone);
  return operationResult("enroll", "noop", classType, {
    cacheState: "not_open",
    enrollmentOpensAt:
      timeToEnroll === null || timeToEnroll === undefined
        ? null
        : zonedIso(now + timeToEnroll * 1000, timezone),
    lastCheckedAt,
  });
}

async function loadClasses(
  client,
  { classDate, timezone, sleep = defaultSleep, emptyRetryTotal = 3, emptyRetryBackoffMs = 50 },
) {
  // Python's _get_classes_tags_with_retry treats an empty class list as
  // transient; a bounded retry keeps that behavior within the subrequest cap.
  for (let attempt = 0; ; attempt += 1) {
    const html = await client.fetchClassesHtml(zonedMidnightMs(classDate, timezone));
    const classes = parseClasses(html, { date: classDate, timezone });
    if (classes.length > 0) {
      return classes;
    }
    if (attempt >= emptyRetryTotal) {
      throw new NoClassesFoundError(classDate);
    }
    await sleep(emptyRetryBackoffMs * 2 ** attempt);
  }
}

export async function runOperation({
  client,
  operation = "enroll",
  classDate,
  classTime,
  classType,
  timeoutSeconds = 900,
  notOpenIsNoop = false,
  now = () => Date.now(),
  sleep = defaultSleep,
  maxPolls = 20,
} = {}) {
  if (!client || !classDate || !classTime) {
    throw new Error("client, classDate, and classTime are required");
  }
  if (operation !== "enroll" && operation !== "unenroll") {
    throw new Error(`Unsupported operation: ${operation}`);
  }
  const normalizedClassTime = String(classTime).padStart(5, "0");
  const classTypes = parseClassTypes(classType);
  if (classTypes.length === 0) {
    throw new Error("classType must include at least one class name");
  }
  const timezone = client.timezone ?? "Europe/Lisbon";
  if (operation === "unenroll") {
    const classes = await loadClasses(client, { classDate, timezone, sleep });
    let firstMatch = null;
    for (const candidate of classTypes) {
      try {
        const selected = pickClass(classes, {
          classTime: normalizedClassTime,
          classType: candidate,
          classDate,
        });
        firstMatch ??= selected;
        if (selected.userIsEnrolled) {
          if (!selected.unenrollUrl) {
            throw new UnparseableError("Unenroll URL is not set");
          }
          await client.unenroll(selected.unenrollUrl);
          return operationResult("unenroll", "success", selected.name);
        }
      } catch (error) {
        if (!(error instanceof ClassNotFoundError)) {
          throw error;
        }
      }
    }
    return operationResult("unenroll", "noop", firstMatch?.name ?? classTypes[0]);
  }

  const startedAt = now();
  let polls = 0;
  let lastSelected = null;
  while (polls < maxPolls && now() - startedAt < timeoutSeconds * 1000) {
    polls += 1;
    const classes = await loadClasses(client, { classDate, timezone, sleep });
    const selected = pickFirstClass(classes, {
      classTime: normalizedClassTime,
      classTypes,
      classDate,
    });
    lastSelected = selected;
    const resolvedClassType = selected.name || classTypes[0];
    if (selected.userIsEnrolled) {
      return operationResult("enroll", "noop", resolvedClassType);
    }
    if (selected.isOverbooked && selected.isFull) {
      throw new ClassIsOverbookedError();
    }
    if (selected.isOpen) {
      if (!selected.enrollUrl) {
        throw new ClassNotOpenError("Class is open but cannot be enrolled");
      }
      try {
        await client.enroll(selected.enrollUrl);
      } catch (error) {
        if (error instanceof UserAlreadyEnrolledError) {
          return operationResult("enroll", "noop", resolvedClassType);
        }
        throw error;
      }
      return operationResult("enroll", "success", resolvedClassType);
    }
    const timeToEnroll = selected.timeToEnroll;
    const elapsedSeconds = Math.max(0, Math.ceil((now() - startedAt) / 1000));
    const remainingSeconds = Math.max(0, timeoutSeconds - elapsedSeconds);
    const cannotWait =
      selected.enrollmentDeadlineExpired || timeToEnroll === null || timeToEnroll === undefined || timeToEnroll > remainingSeconds;
    if (cannotWait) {
      if (notOpenIsNoop) {
        return closedResult({ classType: resolvedClassType, timeToEnroll, now: now(), timezone });
      }
      if (selected.enrollmentDeadlineExpired || timeToEnroll === null || timeToEnroll === undefined) {
        throw new ClassNotOpenError();
      }
      throw new RegyboxTimeoutError(timeoutSeconds, { timeToEnroll });
    }
    // One long sleep gets near the opening, then short polls avoid spending
    // dozens of Worker subrequests on a server-side countdown.
    const waitSeconds = timeToEnroll > 10 ? timeToEnroll - 10 : Math.min(2, Math.max(1, timeToEnroll));
    await sleep(waitSeconds * 1000);
  }
  if (notOpenIsNoop) {
    return closedResult({
      classType: lastSelected?.name ?? classTypes[0],
      timeToEnroll: lastSelected?.timeToEnroll ?? null,
      now: now(),
      timezone,
    });
  }
  throw new RegyboxTimeoutError(timeoutSeconds);
}
