const RUN_INDEX_KEY = "regybox:v1:runs:index";
const RUN_PREFIX = "regybox:v1:run:";
const RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_RUN_SUMMARIES = 400;
const MAX_TRACE_EVENTS = 500;
const MAX_MESSAGE_LENGTH = 600;

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const STATUSES = new Set(["running", "success", "noop", "partial", "failure"]);
const DATA_FIELDS = new Set([
  "attempt",
  "cacheAgeMs",
  "cacheState",
  "classDate",
  "classTime",
  "classType",
  "durationMs",
  "decision",
  "elapsedMs",
  "enrollmentOpensAt",
  "errorCode",
  "eventCount",
  "httpStatus",
  "mode",
  "nextRetryMs",
  "operation",
  "outcome",
  "plannedOperations",
  "poll",
  "remainingMs",
  "reason",
  "refreshDueAt",
  "timeToEnroll",
  "timerSeconds",
  "previousTimerSeconds",
  "endpointPath",
  "actionCount",
  "buttonCount",
  "attributeNames",
  "classNames",
  "fetchCount",
  "fetchLimit",
  "isOpen",
  "userIsEnrolled",
  "isFull",
  "enrollmentDeadlineExpired",
  "remainingSeconds",
  "waitSeconds",
  "timeoutSeconds",
  "graceRemainingSeconds",
  "graceSeconds",
]);

function parseObject(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeText(value, limit = MAX_MESSAGE_LENGTH) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "[redacted credential]")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "[redacted credential]")
    .replace(
      /(["']?(?:PHPSESSID|regybox_user|password|token|secret|cookie)["']?\s*[:=]\s*)["']?[^"',}\s;]+["']?/gi,
      "$1[redacted]",
    )
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[redacted email]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/([?&][\w.-]+=)[^&\s]+/g, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function safeScalar(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return safeText(value, 200);
  }
  return undefined;
}

function safeEndpointPath(value) {
  try {
    return safeText(new URL(String(value), "https://regybox.invalid").pathname, 200);
  } catch {
    return undefined;
  }
}

function safeData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (!DATA_FIELDS.has(key)) {
      continue;
    }
    if (key === "endpointPath") {
      const pathname = safeEndpointPath(value);
      if (pathname) result[key] = pathname;
      continue;
    }
    if (Array.isArray(value) && ["attributeNames", "classNames"].includes(key)) {
      result[key] = value.slice(0, 20).map((item) => safeText(item, 100)).filter(Boolean);
      continue;
    }
    const sanitized = safeScalar(value);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return null;
  }
  const safe = {
    operation: operation.operation === "unenroll" ? "unenroll" : operation.operation === "calendar" ? "calendar" : "enroll",
    outcome: safeText(operation.outcome, 30),
  };
  for (const [key, limit] of [["classDate", 20], ["classTime", 10], ["classType", 200], ["errorCode", 100]]) {
    const value = safeText(operation[key], limit);
    if (value) {
      safe[key] = value;
    }
  }
  return safe;
}

function randomRunId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function runKey(id) {
  return `${RUN_PREFIX}${id}`;
}

function summaryFor(record) {
  return {
    id: record.id,
    status: record.status,
    scheduledAt: record.scheduledAt,
    startedAt: record.startedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
    mode: record.mode,
    plannedOperations: record.plannedOperations,
    operations: record.operations,
    traceTruncated: record.traceTruncated,
  };
}

async function readIndex(kv) {
  const parsed = parseObject(await kv.get(RUN_INDEX_KEY));
  return Array.isArray(parsed?.runs) ? parsed.runs : [];
}

async function writeRecord(kv, record) {
  await kv.put(runKey(record.id), JSON.stringify(record), { expirationTtl: RUN_TTL_SECONDS });
}

async function upsertIndex(kv, record) {
  const existing = await readIndex(kv);
  const retentionBoundary = Date.parse(record.startedAt) - RUN_TTL_SECONDS * 1000;
  const runs = [
    summaryFor(record),
    ...existing.filter((run) =>
      run?.id !== record.id && Date.parse(run?.startedAt) >= retentionBoundary,
    ),
  ]
    .slice(0, MAX_RUN_SUMMARIES);
  await kv.put(RUN_INDEX_KEY, JSON.stringify({ runs }), { expirationTtl: RUN_TTL_SECONDS });
}

function consoleMethod(level) {
  if (level === "error") return console.error;
  if (level === "warn") return console.warn;
  return console.log;
}

export function outcomeStatus(operations, failed = false) {
  if (failed) return "failure";
  if (!Array.isArray(operations) || operations.length === 0) return "noop";
  const failures = operations.filter((operation) => operation?.outcome === "failure").length;
  if (failures === operations.length) return "failure";
  if (failures > 0) return "partial";
  if (operations.some((operation) => ["success", "dispatched"].includes(operation?.outcome))) {
    return "success";
  }
  return "noop";
}

export async function createRunRecorder({
  kv,
  mode,
  scheduledAt,
  now = () => Date.now(),
  id = randomRunId(),
}) {
  if (!kv || !/^[a-f0-9]{36}$/.test(id)) {
    throw new Error("A KV binding and valid 36-character run ID are required");
  }
  const startedMs = now();
  const record = {
    version: 1,
    id,
    status: "running",
    scheduledAt: new Date(Number.isFinite(scheduledAt) ? scheduledAt : startedMs).toISOString(),
    startedAt: new Date(startedMs).toISOString(),
    mode: safeText(mode || "unconfigured", 30),
    plannedOperations: 0,
    operations: [],
    trace: [],
    traceTruncated: false,
  };
  await writeRecord(kv, record);
  await upsertIndex(kv, record);

  const persist = async () => {
    await writeRecord(kv, record);
    await upsertIndex(kv, record);
  };

  return {
    id,
    get record() {
      return structuredClone(record);
    },
    trace({ level = "info", scope = "run", operationIndex, code = "event", message, data } = {}) {
      const atMs = now();
      const event = {
        at: new Date(atMs).toISOString(),
        elapsedMs: Math.max(0, atMs - startedMs),
        level: LEVELS.has(level) ? level : "info",
        scope: safeText(scope, 60) || "run",
        ...(Number.isInteger(operationIndex) && operationIndex >= 0 ? { operationIndex } : {}),
        code: safeText(code, 100) || "event",
        message: safeText(message),
      };
      const sanitizedData = safeData(data);
      if (sanitizedData) event.data = sanitizedData;
      consoleMethod(event.level)(`regybox: [run ${id}] ${event.message}`, sanitizedData ?? "");
      if (record.trace.length < MAX_TRACE_EVENTS) {
        record.trace.push(event);
      } else {
        record.traceTruncated = true;
      }
      return event;
    },
    async setPlan(plannedOperations) {
      record.plannedOperations = Math.max(0, Number.parseInt(plannedOperations, 10) || 0);
      await persist();
    },
    async finalize({ status, operations = [], errorCode } = {}) {
      const finishedMs = now();
      record.status = STATUSES.has(status) && status !== "running"
        ? status
        : outcomeStatus(operations, Boolean(errorCode));
      record.finishedAt = new Date(finishedMs).toISOString();
      record.durationMs = Math.max(0, finishedMs - startedMs);
      record.operations = operations.map(safeOperation).filter(Boolean);
      if (errorCode) record.errorCode = safeText(errorCode, 100);
      await persist();
      return summaryFor(record);
    },
  };
}

export async function readRuns(kv) {
  if (!kv) return [];
  try {
    return await readIndex(kv);
  } catch (error) {
    console.warn("regybox: run index read failed:", error);
    return [];
  }
}

export async function readRun(kv, id) {
  if (!kv || !/^[a-f0-9]{36}$/.test(String(id))) return null;
  try {
    return parseObject(await kv.get(runKey(id)));
  } catch (error) {
    console.warn("regybox: run read failed:", error);
    return null;
  }
}

export const runConstants = {
  RUN_INDEX_KEY,
  RUN_PREFIX,
  RUN_TTL_SECONDS,
  RUN_RETENTION_DAYS: RUN_TTL_SECONDS / (24 * 60 * 60),
  MAX_RUN_SUMMARIES,
  MAX_TRACE_EVENTS,
};
