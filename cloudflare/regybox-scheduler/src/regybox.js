import { parseFragment } from "parse5";

const DOMAIN = "https://www.regybox.pt/app/app_nova/";
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const DOMAIN_ORIGIN = new URL(DOMAIN).origin;
const CLASS_ACTION_PATH_PREFIX = "/app/app_nova/php/aulas/";
const OPENING_ROLLOVER_GRACE_MS = 30_000;
const OPENING_ROLLOVER_TOLERANCE_SECONDS = 60;

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
  constructor(message = "Unable to parse HTML", diagnostics = undefined) {
    super(message);
    this.name = "UnparseableError";
    if (diagnostics) {
      this.safeDiagnostics = diagnostics;
    }
  }
}

export class NoClassesFoundError extends Error {
  constructor(classDate = "") {
    super(`No classes found on ${classDate}`);
    this.name = "NoClassesFoundError";
  }
}

function attributes(node) {
  return Object.fromEntries((node?.attrs ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
}

function classTokens(node) {
  return String(attributes(node).class ?? "").split(/\s+/).filter(Boolean);
}

function hasClass(node, ...names) {
  const tokens = new Set(classTokens(node));
  return names.every((name) => tokens.has(name));
}

function elements(root, tagName = null) {
  const matches = [];
  const visit = (node) => {
    if (node?.tagName && (!tagName || node.tagName === tagName)) {
      matches.push(node);
    }
    for (const child of node?.childNodes ?? []) {
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function descendants(root, tagName = null) {
  return elements({ childNodes: root?.childNodes ?? [] }, tagName);
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

function textContent(node) {
  const parts = [];
  const visit = (current) => {
    if (current?.nodeName === "#text") {
      parts.push(current.value);
    }
    for (const child of current?.childNodes ?? []) {
      visit(child);
    }
  };
  visit(node);
  return fixText(parts.join(" "));
}

function parseClassDocument(html) {
  return parseFragment(String(html));
}

function classBlocks(document) {
  return elements(document, "div").filter((node) => hasClass(node, "filtro0"));
}

function findDiv(nodes, predicate) {
  return nodes.find((node) => predicate(attributes(node), node));
}

function findLastDiv(nodes, predicate) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (predicate(attributes(nodes[index]), nodes[index])) {
      return nodes[index];
    }
  }
  return undefined;
}

function hasStyle(node, pattern) {
  return pattern.test(String(attributes(node).style ?? ""));
}

function buttonActions(block) {
  const actions = [];
  const unknownActionEndpoints = [];
  let malformedBookingControls = 0;
  for (const button of descendants(block, "button")) {
    const attrs = attributes(button);
    const looksLikeBookingControl = hasClass(button, "buts_inscrever");
    const urls = String(attrs.onclick ?? "").match(/[^'"\s,(]+\.php(?:\?[^'"\s,)]*)?/gi) ?? [];
    let recognizedForButton = false;
    for (const rawUrl of urls) {
      let url;
      try {
        url = new URL(decodeEntities(rawUrl), DOMAIN);
      } catch {
        continue;
      }
      const pathname = url.pathname;
      const knownAction =
        pathname.endsWith("/marca_aulas.php") || pathname.endsWith("/cancela_aula.php");
      if (
        knownAction &&
        (url.origin !== DOMAIN_ORIGIN || !pathname.startsWith(CLASS_ACTION_PATH_PREFIX))
      ) {
        throw new UnparseableError("Class action control used an unexpected origin or path", {
          actionEndpoints: actions.map(({ pathname: actionPath }) => actionPath),
          unexpectedOriginEndpoints: [pathname],
        });
      }
      if (pathname === `${CLASS_ACTION_PATH_PREFIX}marca_aulas.php`) {
        actions.push({ operation: "enroll", url: url.href, pathname });
        recognizedForButton = true;
      } else if (pathname === `${CLASS_ACTION_PATH_PREFIX}cancela_aula.php`) {
        actions.push({ operation: "unenroll", url: url.href, pathname });
        recognizedForButton = true;
      } else if (looksLikeBookingControl && /\/aulas\/[^/]+\.php$/i.test(pathname)) {
        unknownActionEndpoints.push(pathname);
      }
    }
    if (looksLikeBookingControl && !recognizedForButton && unknownActionEndpoints.length === 0) {
      malformedBookingControls += 1;
    }
  }
  const diagnostics = {
    actionEndpoints: actions.map(({ pathname }) => pathname),
    unknownActionEndpoints,
    malformedBookingControls,
  };
  if (unknownActionEndpoints.length > 0) {
    throw new UnparseableError(
      `Unknown class action endpoint: ${unknownActionEndpoints.join(", ")}`,
      diagnostics,
    );
  }
  if (actions.length > 1) {
    throw new UnparseableError(
      `Ambiguous class action controls: ${actions.map(({ pathname }) => pathname).join(", ")}`,
      diagnostics,
    );
  }
  if (malformedBookingControls > 0) {
    throw new UnparseableError("Booking control did not contain a recognizable class action", diagnostics);
  }
  return actions[0] ?? null;
}

function timerValue(block) {
  for (const input of descendants(block, "input")) {
    const attrs = attributes(input);
    if (hasClass(input, "timers")) {
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
  const rootAttrs = attributes(block);
  const timestamp = String(rootAttrs?.id ?? "").match(/^feed_time_slot(\d+)$/);
  if (!timestamp) {
    throw new UnparseableError("Missing class timestamp");
  }
  const nodes = descendants(block, "div");
  const leftHalf = nodes.filter(
    (node) => attributes(node).align === "left" && hasClass(node, "col-50"),
  );
  if (leftHalf.length === 0) {
    throw new UnparseableError("Missing class name");
  }
  const rightHalf = nodes.find(
    (node) => attributes(node).align === "right" && hasClass(node, "col-50"),
  );
  const timeNode = findDiv(
    nodes,
    (attrs, node) =>
      attrs.align === "left" &&
      hasClass(node, "col") &&
      /\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/.test(textContent(node)),
  );
  const capacityNode = findDiv(
    nodes,
    (attrs, node) =>
      attrs.align === "center" && hasClass(node, "col") && /\S+\s+(?:of|de)\s+\S+/i.test(textContent(node)),
  );
  if (!rightHalf || !timeNode || !capacityNode) {
    throw new UnparseableError("Missing class fields");
  }
  const time = textContent(timeNode).match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  const capacity = textContent(capacityNode).match(/^(\S+)\s+(?:of|de)\s+(\S+)$/i);
  if (!time || !capacity) {
    throw new UnparseableError("Unexpected time or capacity format");
  }
  const curCapacity = parseCapacity(capacity[1]);
  if (curCapacity === null) {
    throw new UnparseableError(`Unexpected capacity value: ${capacity[1]}`);
  }
  const maxCapacity = parseCapacity(capacity[2]);
  const buttonAction = buttonActions(block);
  const isOpenByOtherEnrollment = nodes.some(
    (node) => hasClass(node, "letra_10") && hasStyle(node, /padding-top:\s*7px/i),
  );
  const isOpen = Boolean(buttonAction) || isOpenByOtherEnrollment;
  const enrolledStatus = nodes.some(
    (node) =>
      attributes(node).align === "right" &&
      hasClass(node, "ok_color") &&
      hasStyle(node, /padding-top:\s*1px/i),
  );
  let userIsEnrolled = enrolledStatus;
  let enrollUrl = null;
  let unenrollUrl = null;
  if (!enrolledStatus && buttonAction?.operation === "unenroll") {
    userIsEnrolled = true;
    unenrollUrl = buttonAction.url;
  } else if (!enrolledStatus && buttonAction?.operation === "enroll") {
    enrollUrl = buttonAction.url;
  }
  const error = descendants(block, "span").some((node) => hasClass(node, "erro_color"));
  const userIsWaitlisted = nodes.some((node) => hasClass(node, "preloader", "color-orange"));
  const isFull = maxCapacity === null ? false : curCapacity >= maxCapacity;
  const isOverbooked = isFull && error;
  const enrollmentDeadlineExpired = error && !isFull;
  let userIsBlocked = !isOpen && !userIsEnrolled;
  let isOver = false;
  const state = findLastDiv(
    nodes,
    (attrs, node) => attrs.align === "right" && hasClass(node, "col"),
  );
  if (!state) {
    throw new UnparseableError("Missing class state");
  }
  if (descendants(state, "span").some((node) => hasClass(node, "erro_color"))) {
    userIsBlocked = true;
  } else {
    const stateChild = findDiv(
      descendants(state, "div"),
      (_attrs, node) => hasStyle(node, /padding-top:\s*7px/i),
    );
    if (stateChild) {
      if (userIsWaitlisted) {
        isOver = false;
      } else if (!attributes(stateChild).class) {
        isOver = true;
      } else if (hasClass(stateChild, "letra_10")) {
        userIsBlocked = true;
      }
    }
  }
  const timer = timerValue(block);
  return {
    name: textContent(leftHalf[0]),
    details: textContent(rightHalf),
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
  return classBlocks(parseClassDocument(html)).map((block) => parseClassBlock(block, { timezone }));
}

function parseClassesAtTime(
  html,
  { classTime, classTypes = [], date, timezone = "Europe/Lisbon" } = {},
) {
  void date; // The timestamp embedded in each card is the Python source of truth.
  const blocks = classBlocks(parseClassDocument(html));
  return {
    total: blocks.length,
    classes: blocks
      .filter(
        (block) => hasClassTime(block, classTime) && hasCandidateClassName(block, classTypes),
      )
      .map((block) => parseClassBlock(block, { timezone })),
  };
}

function hasCandidateClassName(block, classTypes) {
  const candidates = new Set(
    (Array.isArray(classTypes) ? classTypes : parseClassTypes(classTypes)).map((name) =>
      String(name).toUpperCase(),
    ),
  );
  if (candidates.size === 0) {
    return true;
  }
  const nameNode = descendants(block, "div").find(
    (node) => attributes(node).align === "left" && hasClass(node, "col-50"),
  );
  return Boolean(nameNode && candidates.has(textContent(nameNode).toUpperCase()));
}

function hasClassTime(block, classTime) {
  const time = String(classTime);
  return descendants(block, "div").some(
    (node) =>
      attributes(node).align === "left" &&
      hasClass(node, "col") &&
      textContent(node).startsWith(`${time} -`),
  );
}

export function parseClass(html, { timezone = "Europe/Lisbon" } = {}) {
  const document = parseClassDocument(html);
  const block = classBlocks(document)[0] ?? elements(document, "div")[0];
  if (!block) {
    throw new UnparseableError("Missing class card");
  }
  return parseClassBlock(block, { timezone });
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
  now = () => Date.now(),
  onTrace = async () => {},
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
  const emitTrace = async (event) => {
    try {
      await onTrace(event);
    } catch (error) {
      console.warn("regybox: HTTP trace callback failed:", error);
    }
  };

  async function getHtml(path, params = {}) {
    const url = new URL(path, DOMAIN);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    let response;
    for (let attempt = 0; attempt <= retryTotal; attempt += 1) {
      const requestStartedAt = now();
      try {
        response = await fetchImpl(url.href, { headers, method: "GET" });
      } catch (error) {
        await emitTrace({
          level: attempt === retryTotal ? "error" : "warn",
          scope: "http",
          code: "regybox_request_network_error",
          message: attempt === retryTotal
            ? `Regybox request failed after ${attempt + 1} attempt(s)`
            : `Regybox request failed; retrying attempt ${attempt + 2}`,
          data: {
            attempt: attempt + 1,
            durationMs: Math.max(0, now() - requestStartedAt),
            endpointPath: url.pathname,
            nextRetryMs: attempt === retryTotal ? undefined : retryBackoffMs * 2 ** attempt,
          },
        });
        if (attempt === retryTotal) {
          throw error;
        }
        await sleep(retryBackoffMs * 2 ** attempt);
        continue;
      }
      await emitTrace({
        level: RETRYABLE_STATUS_CODES.has(response.status) ? "warn" : "info",
        scope: "http",
        code: "regybox_response_received",
        message: `Regybox request returned HTTP ${response.status}`,
        data: {
          attempt: attempt + 1,
          durationMs: Math.max(0, now() - requestStartedAt),
          endpointPath: url.pathname,
          httpStatus: response.status,
        },
      });
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === retryTotal) {
        break;
      }
      await emitTrace({
        level: "warn",
        scope: "http",
        code: "regybox_request_retry",
        message: `Regybox returned HTTP ${response.status}; retrying attempt ${attempt + 2}`,
        data: {
          attempt: attempt + 1,
          endpointPath: url.pathname,
          httpStatus: response.status,
          nextRetryMs: retryBackoffMs * 2 ** attempt,
        },
      });
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
  {
    classDate,
    classTime,
    classTypes,
    timezone,
    sleep = defaultSleep,
    emptyRetryTotal = 3,
    emptyRetryBackoffMs = 50,
    beforeFetch = async () => {},
  },
) {
  // Python's _get_classes_tags_with_retry treats an empty class list as
  // transient; a bounded retry keeps that behavior within the subrequest cap.
  for (let attempt = 0; ; attempt += 1) {
    await beforeFetch();
    const html = await client.fetchClassesHtml(zonedMidnightMs(classDate, timezone));
    const { total, classes } = parseClassesAtTime(html, {
      classTime,
      classTypes,
      date: classDate,
      timezone,
    });
    if (total > 0) {
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
  maxPolls = 40,
  onTrace = async () => {},
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
  const emitTrace = async (event) => {
    try {
      await onTrace(event);
    } catch (error) {
      console.warn("regybox: operation trace callback failed:", error);
    }
  };
  let fetches = 0;
  const beforeFetch = async () => {
    if (fetches >= maxPolls) {
      await emitTrace({
        level: "error",
        scope: "regybox",
        code: "class_fetch_limit_reached",
        message: `Stopped after ${maxPolls} class-page fetches`,
        data: { fetchCount: fetches, fetchLimit: maxPolls },
      });
      throw new RegyboxTimeoutError(timeoutSeconds);
    }
    fetches += 1;
  };
  if (operation === "unenroll") {
    const classes = await loadClasses(client, {
      classDate, classTime: normalizedClassTime, classTypes, timezone, sleep, beforeFetch,
    });
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
          await emitTrace({
            level: "info",
            scope: "regybox",
            code: "unenrollment_attempt",
            message: "Attempting to cancel enrollment",
          });
          await client.unenroll(selected.unenrollUrl);
          await emitTrace({
            level: "info",
            scope: "regybox",
            code: "unenrollment_success",
            message: "Enrollment cancelled successfully",
          });
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
  let predictedOpeningAt = null;
  let openingBecameImminent = false;
  let rolloverGraceStartedAt = null;
  let hasWaited = false;
  let previousTimerSeconds = null;
  while (now() - startedAt < timeoutSeconds * 1000) {
    const classes = await loadClasses(client, {
      classDate, classTime: normalizedClassTime, classTypes, timezone, sleep, beforeFetch,
    });
    const selected = pickFirstClass(classes, {
      classTime: normalizedClassTime,
      classTypes,
      classDate,
    });
    const resolvedClassType = selected.name || classTypes[0];
    const observedAt = now();
    await emitTrace({
      level: "info",
      scope: "regybox",
      code: "class_state_observed",
      message: "Parsed class state",
      data: {
        fetchCount: fetches,
        isOpen: selected.isOpen,
        userIsEnrolled: selected.userIsEnrolled,
        isFull: selected.isFull,
        enrollmentDeadlineExpired: selected.enrollmentDeadlineExpired,
        timerSeconds: selected.timeToEnroll,
      },
    });
    if (selected.userIsEnrolled) {
      await emitTrace({
        level: "info",
        scope: "regybox",
        code: "already_enrolled",
        message: "Skipped because the user is already enrolled",
      });
      return operationResult("enroll", "noop", resolvedClassType);
    }
    if (selected.isOverbooked && selected.isFull) {
      throw new ClassIsOverbookedError();
    }
    if (selected.isOpen) {
      if (!selected.enrollUrl) {
        throw new ClassNotOpenError("Class is open but cannot be enrolled");
      }
      await emitTrace({
        level: "info",
        scope: "regybox",
        code: "enrollment_attempt",
        message: "Attempting to enroll",
      });
      try {
        await client.enroll(selected.enrollUrl);
      } catch (error) {
        if (error instanceof UserAlreadyEnrolledError) {
          await emitTrace({
            level: "info",
            scope: "regybox",
            code: "already_enrolled",
            message: "Enrollment response reported that the user is already enrolled",
          });
          return operationResult("enroll", "noop", resolvedClassType);
        }
        throw error;
      }
      await emitTrace({
        level: "info",
        scope: "regybox",
        code: "enrollment_success",
        message: "Enrolled successfully",
      });
      return operationResult("enroll", "success", resolvedClassType);
    }
    const timeToEnroll = selected.timeToEnroll;
    const hasTimer = timeToEnroll !== null && timeToEnroll !== undefined;
    const observedOpeningAt = hasTimer ? observedAt + timeToEnroll * 1000 : null;
    predictedOpeningAt ??= observedOpeningAt;
    if (hasTimer && timeToEnroll <= 10) {
      openingBecameImminent = true;
    }
    const timerJumped = Boolean(
      openingBecameImminent &&
      observedOpeningAt !== null &&
      predictedOpeningAt !== null &&
      observedOpeningAt - predictedOpeningAt > OPENING_ROLLOVER_TOLERANCE_SECONDS * 1000,
    );
    const openingStateDisappeared = Boolean(
      openingBecameImminent && (selected.enrollmentDeadlineExpired || !hasTimer),
    );
    if ((timerJumped || openingStateDisappeared) && rolloverGraceStartedAt === null) {
      rolloverGraceStartedAt = observedAt;
      const message = timerJumped
        ? `Timer jumped from ${previousTimerSeconds} seconds to ${timeToEnroll} seconds; treating as an opening-boundary inconsistency`
        : "Opening countdown disappeared at the enrollment boundary; treating as an opening-boundary inconsistency";
      await emitTrace({
        level: "error",
        scope: "regybox",
        code: "opening_boundary_inconsistency",
        message,
        data: {
          previousTimerSeconds,
          timerSeconds: timeToEnroll,
          enrollmentDeadlineExpired: selected.enrollmentDeadlineExpired,
        },
      });
    }
    if (rolloverGraceStartedAt !== null) {
      const graceElapsedMs = observedAt - rolloverGraceStartedAt;
      if (graceElapsedMs >= OPENING_ROLLOVER_GRACE_MS) {
        throw new UnparseableError("Enrollment state remained inconsistent after opening", {
          fetchCount: fetches,
          graceSeconds: OPENING_ROLLOVER_GRACE_MS / 1000,
          timerSeconds: timeToEnroll,
          enrollmentDeadlineExpired: selected.enrollmentDeadlineExpired,
        });
      }
      hasWaited = true;
      await emitTrace({
        level: "warn",
        scope: "regybox",
        code: "opening_boundary_grace_retry",
        message: "Opening-boundary state is inconsistent; retrying in 1 second",
        data: {
          waitSeconds: 1,
          graceRemainingSeconds: Math.ceil((OPENING_ROLLOVER_GRACE_MS - graceElapsedMs) / 1000),
        },
      });
      await sleep(1000);
      previousTimerSeconds = timeToEnroll;
      continue;
    }
    const elapsedSeconds = Math.max(0, Math.ceil((observedAt - startedAt) / 1000));
    const remainingSeconds = Math.max(0, timeoutSeconds - elapsedSeconds);
    const cannotWait =
      selected.enrollmentDeadlineExpired || !hasTimer || timeToEnroll > remainingSeconds;
    if (cannotWait) {
      if (notOpenIsNoop && !hasWaited) {
        await emitTrace({
          level: "info",
          scope: "regybox",
          code: "class_not_open",
          message: hasTimer
            ? `Enrollment opens in ${timeToEnroll} seconds, beyond this run's wait window`
            : "Class is not open and has no enrollment countdown",
          data: { timerSeconds: timeToEnroll, remainingSeconds },
        });
        return closedResult({ classType: resolvedClassType, timeToEnroll, now: observedAt, timezone });
      }
      if (selected.enrollmentDeadlineExpired || timeToEnroll === null || timeToEnroll === undefined) {
        throw new ClassNotOpenError();
      }
      throw new RegyboxTimeoutError(timeoutSeconds, { timeToEnroll });
    }
    const waitSeconds = timeToEnroll > 60 ? 60 : timeToEnroll > 10 ? 10 : 1;
    hasWaited = true;
    await emitTrace({
      level: "info",
      scope: "regybox",
      code: "enrollment_wait",
      message: `Opening in ${timeToEnroll} seconds; retrying in ${waitSeconds} second${waitSeconds === 1 ? "" : "s"}`,
      data: { timerSeconds: timeToEnroll, waitSeconds, remainingSeconds },
    });
    previousTimerSeconds = timeToEnroll;
    await sleep(waitSeconds * 1000);
  }
  await emitTrace({
    level: "error",
    scope: "regybox",
    code: "enrollment_wait_timeout",
    message: `Timed out after waiting ${timeoutSeconds} seconds for enrollment to open`,
    data: { fetchCount: fetches, timeoutSeconds },
  });
  throw new RegyboxTimeoutError(timeoutSeconds);
}
