import { buildFailureFingerprint, errorPayload } from "./failures.js";
import { createRegyboxClient, runOperation } from "./regybox.js";

const LAST_RUN_KEY = "regybox:v1:last_run";
const LAST_RUN_TTL_SECONDS = 604800;
const STATE_TTL_SECONDS = 2592000;
const WALL_BUDGET_MS = 13 * 60 * 1000;
const MINIMUM_OPERATION_BUDGET_MS = 30 * 1000;

function configured(value) {
  return Boolean(String(value ?? "").trim());
}

function missingConfiguration(env) {
  return ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "PHPSESSID", "REGYBOX_USER"].filter(
    (name) => !configured(env[name]),
  );
}

function timeoutSeconds(env) {
  const configuredTimeout = Number(env.TIMEOUT_SECONDS ?? 900);
  return Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 900;
}

function operationDetails(dispatch) {
  const inputs = dispatch.inputs ?? {};
  return {
    operation: dispatch.operation,
    classDate: inputs["class-date"],
    classTime: inputs["class-time"],
    classType: inputs["class-type"],
    calendarEventName: inputs["calendar-event-name"],
    cacheKey: inputs["cache-key"],
    calendarFingerprint: inputs["calendar-fingerprint"],
  };
}

function summaryOperation(details, outcome, extra = {}) {
  return {
    operation: details.operation,
    classDate: details.classDate,
    classTime: details.classTime,
    classType: details.classType,
    outcome,
    ...extra,
  };
}

function parseCachedValue(value) {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState({ kv, details, result }) {
  if (result.status !== "success" && result.status !== "noop") {
    return false;
  }
  const isNotOpen = result.status === "noop" && result.cacheState === "not_open";
  if (isNotOpen && !result.enrollmentOpensAt) {
    return false;
  }

  const state = isNotOpen
    ? "not_open"
    : details.operation === "unenroll"
      ? "unenrolled"
      : "enrolled";
  const existing = parseCachedValue(await kv.get(details.cacheKey));
  const payload = {
    state,
    classDate: details.classDate,
    classTime: details.classTime,
    classType: result.classType,
    calendarEventName: details.calendarEventName,
    calendarFingerprint: details.calendarFingerprint,
  };
  if (result.enrollmentOpensAt) {
    payload.enrollmentOpensAt = result.enrollmentOpensAt;
  }
  if (result.lastCheckedAt) {
    payload.lastCheckedAt = result.lastCheckedAt;
  }
  if (existing.failureNotificationFingerprint) {
    payload.failureNotificationFingerprint = existing.failureNotificationFingerprint;
  }
  await kv.put(details.cacheKey, JSON.stringify(payload), { expirationTtl: STATE_TTL_SECONDS });
  return true;
}

export function executionMode(env) {
  if (["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].every((name) => configured(env[name]))) {
    return "dispatch";
  }
  if (["PHPSESSID", "REGYBOX_USER"].every((name) => configured(env[name]))) {
    return "worker";
  }
  throw new Error(
    `Missing scheduler configuration variables: ${missingConfiguration(env).join(", ")}. ` +
      "Configure GitHub dispatch (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO) or worker execution (PHPSESSID, REGYBOX_USER).",
  );
}

export async function dispatchWorkflow(env, dispatch) {
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

export async function writeLastRun(kv, summary) {
  await kv.put(LAST_RUN_KEY, JSON.stringify(summary), { expirationTtl: LAST_RUN_TTL_SECONDS });
}

export async function readLastRun(kv) {
  return parseCachedValue(await kv.get(LAST_RUN_KEY));
}

export async function executePlan({
  env,
  kv,
  dispatches,
  now = () => Date.now(),
  createClient = createRegyboxClient,
  runOperationImpl = runOperation,
  dispatchWorkflowImpl = dispatchWorkflow,
  sleep,
  onFailure = () => {},
  onResult = () => {},
}) {
  const mode = executionMode(env);
  const startedAt = now();
  const operations = [];
  const summary = {
    ranAt: new Date(startedAt).toISOString(),
    mode,
    plannedOperations: dispatches.length,
    operations,
  };

  try {
    if (mode === "dispatch") {
      for (const dispatch of dispatches) {
        const details = operationDetails(dispatch);
        await dispatchWorkflowImpl(env, dispatch);
        operations.push(summaryOperation(details, "dispatched"));
      }
      return summary;
    }

    const client = createClient({
      phpsessid: env.PHPSESSID,
      regyboxUser: env.REGYBOX_USER,
      timezone: env.TIMEZONE || "Europe/Lisbon",
    });
    await client.bootstrapSession();
    for (const dispatch of dispatches) {
      const details = operationDetails(dispatch);
      const remainingMs = startedAt + WALL_BUDGET_MS - now();
      if (remainingMs < MINIMUM_OPERATION_BUDGET_MS) {
        operations.push(summaryOperation(details, "skipped"));
        continue;
      }
      let result;
      try {
        result = await runOperationImpl({
          client,
          operation: details.operation,
          classDate: details.classDate,
          classTime: details.classTime,
          classType: details.classType,
          timeoutSeconds: Math.min(timeoutSeconds(env), Math.floor(remainingMs / 1000)),
          notOpenIsNoop: true,
          sleep,
        });
      } catch (error) {
        const payload = errorPayload(error);
        const fingerprint = buildFailureFingerprint({ operation: details.operation, error });
        operations.push(summaryOperation(details, "failure", { errorCode: payload.errorCode }));
        await onFailure({ dispatch, error, payload, fingerprint });
        continue;
      }
      await writeState({ kv, details, result });
      await onResult({ dispatch, result });
      operations.push(summaryOperation(details, result.status));
    }
    return summary;
  } finally {
    await writeLastRun(kv, summary);
  }
}
