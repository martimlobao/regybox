import { buildFailureFingerprint, errorPayload } from "./failures.js";
import { notifyFailure, notifyResult } from "./notify.js";
import { UnparseableError, createRegyboxClient, runOperation } from "./regybox.js";
import { recordIncident, resolveStatusUrl } from "./incidents.js";

const LAST_RUN_KEY = "regybox:v1:last_run";
const ACTIVITY_KEY = "regybox:v1:activity";
const LAST_RUN_TTL_SECONDS = 604800;
const STATE_TTL_SECONDS = 2592000;
const WALL_BUDGET_MS = 13 * 60 * 1000;
const MINIMUM_OPERATION_BUDGET_MS = 30 * 1000;
const NOT_OPEN_DISPATCH_WINDOW_MS = 60 * 60 * 1000;
const NOT_OPEN_OPENING_JUMP_TOLERANCE_MS = 2 * 60 * 1000;

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

function activityOperation(details, outcome, at, extra = {}) {
  return {
    at: new Date(at).toISOString(),
    operation: details.operation,
    classDate: details.classDate,
    classTime: details.classTime,
    classType: details.classType,
    calendarEventName: details.calendarEventName,
    outcome,
    ...extra,
  };
}

function operationDescription(details) {
  const classDetails = [details.classType, "on", details.classDate, "at", details.classTime]
    .filter(Boolean)
    .join(" ");
  return `${details.operation} ${classDetails}`;
}

async function recordTrace(recorder, event) {
  if (!recorder) {
    return;
  }
  try {
    await recorder.trace(event);
  } catch (error) {
    console.warn("regybox: run trace write failed:", error);
  }
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
    return null;
  }
  const isNotOpen = result.status === "noop" && result.cacheState === "not_open";
  if (isNotOpen && !result.enrollmentOpensAt) {
    return null;
  }

  const state = isNotOpen
    ? "not_open"
    : details.operation === "unenroll"
      ? "unenrolled"
      : "enrolled";
  // A fresh state payload deliberately drops failureNotificationFingerprint,
  // matching cloudflare_kv.py: once an operation recovers, a later recurrence
  // of the same failure must notify again.
  const payload = {
    state,
    classDate: details.classDate,
    classTime: details.classTime,
    classType: details.classType,
    calendarEventName: details.calendarEventName,
    calendarFingerprint: details.calendarFingerprint,
  };
  if (result.enrollmentOpensAt) {
    payload.enrollmentOpensAt = result.enrollmentOpensAt;
  }
  if (result.lastCheckedAt) {
    payload.lastCheckedAt = result.lastCheckedAt;
  }
  await kv.put(details.cacheKey, JSON.stringify(payload), { expirationTtl: STATE_TTL_SECONDS });
  console.log(`regybox: cached state=${state} for ${operationDescription(details)}`);
  return state;
}

async function assertSafeNotOpenTransition({ kv, details, result, now }) {
  if (result.status !== "noop" || result.cacheState !== "not_open" || !result.enrollmentOpensAt) {
    return;
  }
  const cached = parseCachedValue(await kv.get(details.cacheKey));
  if (cached.state !== "not_open") {
    return;
  }
  const previousOpeningMs = Date.parse(String(cached.enrollmentOpensAt ?? ""));
  const claimedOpeningMs = Date.parse(String(result.enrollmentOpensAt));
  if (!Number.isFinite(previousOpeningMs) || !Number.isFinite(claimedOpeningMs)) {
    return;
  }
  const previousOpeningIsDueSoon = previousOpeningMs - now() <= NOT_OPEN_DISPATCH_WINDOW_MS;
  const openingJumpMs = claimedOpeningMs - previousOpeningMs;
  if (
    previousOpeningIsDueSoon &&
    openingJumpMs > NOT_OPEN_OPENING_JUMP_TOLERANCE_MS
  ) {
    throw new UnparseableError(
      "Regybox moved an already-due enrollment opening unexpectedly far into the future",
      {
        previousEnrollmentOpensAt: new Date(previousOpeningMs).toISOString(),
        claimedEnrollmentOpensAt: new Date(claimedOpeningMs).toISOString(),
        openingJumpSeconds: Math.round(openingJumpMs / 1000),
      },
    );
  }
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

export async function readActivity(kv) {
  const value = await kv.get(ACTIVITY_KEY);
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function appendActivity(kv, entries) {
  if (!entries.length) {
    return;
  }
  try {
    const existing = await readActivity(kv);
    const activity = [...entries].reverse().concat(existing).slice(0, 50);
    await kv.put(ACTIVITY_KEY, JSON.stringify(activity), { expirationTtl: STATE_TTL_SECONDS });
  } catch (error) {
    console.warn("regybox: activity state write failed:", error);
  }
}

export async function executePlan({
  env,
  kv,
  dispatches,
  now = () => Date.now(),
  createClient = createRegyboxClient,
  runOperationImpl = runOperation,
  dispatchWorkflowImpl = dispatchWorkflow,
  notifyFailureImpl = notifyFailure,
  notifyResultImpl = notifyResult,
  sleep,
  onFailure,
  onResult,
  recorder,
}) {
  const mode = executionMode(env);
  const statusUrl = await resolveStatusUrl(env, kv);
  const runUrl = statusUrl && recorder?.id
    ? `${String(statusUrl).replace(/\/+$/, "")}/runs/${recorder.id}`
    : null;
  const reportFailure =
    onFailure ??
    (async (notification) => {
      let incidentUrl = null;
      try {
        incidentUrl = await recordIncident({
          kv,
          statusUrl,
          dispatch: notification.dispatch,
          error: notification.error,
          payload: notification.payload,
          runId: recorder?.id,
        });
      } catch (error) {
        console.warn("regybox: incident record write failed:", error);
      }
      return notifyFailureImpl({ env, kv, ...notification, statusUrl, incidentUrl, runUrl });
    });
  const reportResult =
    onResult ?? ((notification) => notifyResultImpl({ env, kv, ...notification, statusUrl, runUrl }));
  const startedAt = now();
  const operations = [];
  const activity = [];
  const summary = {
    ranAt: new Date(startedAt).toISOString(),
    mode,
    plannedOperations: dispatches.length,
    operations,
  };

  try {
    console.log(`regybox: executing ${dispatches.length} operation(s) in ${mode} mode`);
    await recordTrace(recorder, {
      scope: "executor",
      code: "execution_started",
      message: `Executing ${dispatches.length} operation(s) in ${mode} mode`,
      data: { mode, plannedOperations: dispatches.length },
    });
    if (mode === "dispatch") {
      for (const [operationIndex, dispatch] of dispatches.entries()) {
        const details = operationDetails(dispatch);
        console.log(`regybox: ${operationDescription(details)}`);
        await recordTrace(recorder, {
          scope: "operation",
          operationIndex,
          code: "dispatch_started",
          message: `Dispatching ${operationDescription(details)} to GitHub`,
          data: { operation: details.operation, classDate: details.classDate, classTime: details.classTime, classType: details.classType },
        });
        try {
          await dispatchWorkflowImpl(env, dispatch);
          operations.push(summaryOperation(details, "dispatched"));
          activity.push(activityOperation(details, "dispatched", now()));
          console.log(`regybox: ${operationDescription(details)} -> dispatched to GitHub`);
          await recordTrace(recorder, {
            scope: "operation",
            operationIndex,
            code: "dispatch_succeeded",
            message: `${operationDescription(details)} was dispatched to GitHub`,
            data: { operation: details.operation, outcome: "dispatched" },
          });
        } catch (error) {
          const payload = errorPayload(error);
          operations.push(summaryOperation(details, "failure", { errorCode: payload.errorCode }));
          activity.push(activityOperation(details, "failure", now(), { errorCode: payload.errorCode }));
          console.error(
            `regybox: ${operationDescription(details)} -> failure (${payload.errorCode}): ${error.message}`,
          );
          await recordTrace(recorder, {
            level: "error",
            scope: "operation",
            operationIndex,
            code: "dispatch_failed",
            message: `${operationDescription(details)} failed (${payload.errorCode})`,
            data: { operation: details.operation, outcome: "failure", errorCode: payload.errorCode },
          });
          throw error;
        }
      }
      return summary;
    }

    const client = createClient({
      phpsessid: env.PHPSESSID,
      regyboxUser: env.REGYBOX_USER,
      timezone: env.TIMEZONE || "Europe/Lisbon",
      now,
      onTrace: (event) => recordTrace(recorder, event),
    });
    await recordTrace(recorder, {
      scope: "session",
      code: "session_bootstrap_started",
      message: "Starting Regybox session bootstrap",
    });
    try {
      await client.bootstrapSession();
      await recordTrace(recorder, {
        scope: "session",
        code: "session_bootstrap_succeeded",
        message: "Regybox session bootstrap succeeded",
      });
    } catch (error) {
      await recordTrace(recorder, {
        level: "error",
        scope: "session",
        code: "session_bootstrap_failed",
        message: "Regybox session bootstrap failed",
        data: { errorCode: errorPayload(error).errorCode },
      });
      for (const [operationIndex, dispatch] of dispatches.entries()) {
        const details = operationDetails(dispatch);
        const payload = errorPayload(error);
        const fingerprint = buildFailureFingerprint({ operation: dispatch.operation, error });
        operations.push(summaryOperation(details, "failure", { errorCode: payload.errorCode }));
        activity.push(activityOperation(details, "failure", now(), { errorCode: payload.errorCode }));
        console.error(
          `regybox: ${operationDescription(details)} -> failure (${payload.errorCode}): ${error.message}`,
        );
        await recordTrace(recorder, {
          level: "error",
          scope: "operation",
          operationIndex,
          code: "operation_failed",
          message: `${operationDescription(details)} failed during session bootstrap (${payload.errorCode})`,
          data: { operation: details.operation, outcome: "failure", errorCode: payload.errorCode },
        });
        try {
          await reportFailure({ dispatch, error, payload, fingerprint });
        } catch (notificationError) {
          console.warn("regybox: bootstrap failure notification failed:", notificationError);
        }
      }
      throw error;
    }
    for (const [operationIndex, dispatch] of dispatches.entries()) {
      const details = operationDetails(dispatch);
      const remainingMs = startedAt + WALL_BUDGET_MS - now();
      if (remainingMs < MINIMUM_OPERATION_BUDGET_MS) {
        operations.push(summaryOperation(details, "skipped"));
        activity.push(activityOperation(details, "skipped", now()));
        console.log(`regybox: ${operationDescription(details)} -> skipped (out of time)`);
        await recordTrace(recorder, {
          level: "warn",
          scope: "operation",
          operationIndex,
          code: "operation_skipped",
          message: `${operationDescription(details)} was skipped because the invocation budget was exhausted`,
          data: { operation: details.operation, outcome: "skipped", remainingMs },
        });
        continue;
      }
      console.log(`regybox: ${operationDescription(details)}`);
      await recordTrace(recorder, {
        scope: "operation",
        operationIndex,
        code: "operation_started",
        message: `Starting ${operationDescription(details)}`,
        data: { operation: details.operation, classDate: details.classDate, classTime: details.classTime, classType: details.classType },
      });
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
          onTrace: (event) => recordTrace(recorder, {
            ...event,
            scope: event?.scope || "regybox",
            operationIndex,
          }),
        });
        await assertSafeNotOpenTransition({ kv, details, result, now });
      } catch (error) {
        const payload = errorPayload(error);
        const fingerprint = buildFailureFingerprint({ operation: details.operation, error });
        operations.push(summaryOperation(details, "failure", { errorCode: payload.errorCode }));
        activity.push(activityOperation(details, "failure", now(), { errorCode: payload.errorCode }));
        console.error(
          `regybox: ${operationDescription(details)} -> failure (${payload.errorCode}): ${error.message}`,
        );
        await recordTrace(recorder, {
          level: "error",
          scope: "operation",
          operationIndex,
          code: "operation_failed",
          message: `${operationDescription(details)} failed (${payload.errorCode})`,
          data: { operation: details.operation, outcome: "failure", errorCode: payload.errorCode },
        });
        await reportFailure({ dispatch, error, payload, fingerprint });
        continue;
      }
      const cacheState = await writeState({ kv, details, result });
      if (cacheState) {
        await recordTrace(recorder, {
          scope: "cache",
          operationIndex,
          code: "cache_state_written",
          message: `Cached ${cacheState} state for ${operationDescription(details)}`,
          data: { operation: details.operation, cacheState },
        });
      }
      await reportResult({ dispatch, result });
      operations.push(summaryOperation(details, result.status));
      activity.push(
        activityOperation(details, result.status, now(), {
          ...(cacheState ? { cacheState } : result.cacheState ? { cacheState: result.cacheState } : {}),
        }),
      );
      if (result.status === "noop") {
        const outcomeDetails = [
          result.cacheState || "no change",
          result.enrollmentOpensAt && `opens ${result.enrollmentOpensAt}`,
        ]
          .filter(Boolean)
          .join(", ");
        console.log(`regybox: ${operationDescription(details)} -> noop (${outcomeDetails})`);
        await recordTrace(recorder, {
          scope: "operation",
          operationIndex,
          code: "operation_noop",
          message: `${operationDescription(details)} made no change (${outcomeDetails})`,
          data: { operation: details.operation, outcome: "noop", cacheState: cacheState || result.cacheState },
        });
      } else {
        console.log(`regybox: ${operationDescription(details)} -> ${result.status}`);
        await recordTrace(recorder, {
          scope: "operation",
          operationIndex,
          code: "operation_completed",
          message: `${operationDescription(details)} completed with ${result.status}`,
          data: { operation: details.operation, outcome: result.status, cacheState },
        });
      }
    }
    return summary;
  } finally {
    await appendActivity(kv, activity);
    try {
      await writeLastRun(kv, summary);
    } catch (error) {
      console.warn("regybox: last-run state write failed:", error);
    }
  }
}
