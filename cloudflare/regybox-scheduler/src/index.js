import {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
  parseClassMap,
  resolveClassRules,
} from "./calendar.js";
import {
  appendActivity,
  dispatchWorkflow,
  executePlan,
  executionMode,
  executionSummarySymbol,
  writeLastRun,
} from "./executor.js";
import { rememberStatusOrigin } from "./incidents.js";
import { createRunRecorder, outcomeStatus } from "./runs.js";
import { handleIncidentRequest, handleRunRequest, handleRunsRequest, handleStatusRequest } from "./status.js";
import { bookingPlatform } from "./platform.js";
import { safeErrorMessage, safeErrorValue } from "./failures.js";
import { retryPendingNotifications } from "./notify.js";

export {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
  parseClassMap,
  resolveClassRules,
  dispatchWorkflow,
};

async function safeRecorderCall(recorder, method, ...args) {
  if (!recorder) return null;
  try {
    return await recorder[method](...args);
  } catch (error) {
    console.warn(`regybox: run ${method} write failed:`, safeErrorValue(error));
    return null;
  }
}

function resolvedMode(env) {
  try {
    return executionMode(env);
  } catch {
    return "unconfigured";
  }
}

function resolvedPlatform(env) {
  try {
    return bookingPlatform(env);
  } catch {
    return "regybox";
  }
}

export async function handleScheduled(env, { scheduledAt, now = () => Date.now() } = {}) {
  const mode = resolvedMode(env);
  const platform = resolvedPlatform(env);
  let recorder = null;
  try {
    recorder = await createRunRecorder({ kv: env.REGYBOX_STATE, mode, platform, scheduledAt, now });
  } catch (error) {
    console.warn("regybox: run recorder start failed:", safeErrorValue(error));
  }
  const drainNotifications = async () => {
    try {
      await retryPendingNotifications(env, { onTrace: (event) => safeRecorderCall(recorder, "trace", event) });
    } catch (error) {
      console.warn("regybox: notification queue retry failed:", safeErrorValue(error, { platform }));
      await safeRecorderCall(recorder, "trace", { level: "warn", scope: "notification", code: "notification_queue_failed", message: "Pending notification delivery could not be retried; queued notices remain for the next run" });
    }
  };
  let plan;
  try {
    console.log("regybox: calendar fetch started");
    await safeRecorderCall(recorder, "trace", {
      scope: "calendar",
      code: "calendar_fetch_started",
      message: "Calendar fetch started",
    });
    const calendarResponse = await fetch(env.CALENDAR_URL);
    if (!calendarResponse.ok) {
      throw new Error(`Calendar fetch failed: ${calendarResponse.status}`);
    }
    plan = await buildPlan({
      env,
      kv: env.REGYBOX_STATE,
      icsText: await calendarResponse.text(),
      now: new Date(now()),
      onTrace: (event) => safeRecorderCall(recorder, "trace", event),
    });
    console.log(`regybox: calendar fetched, ${plan.events.length} events in window`);
    console.log(`regybox: plan built, ${plan.dispatches.length} operation(s)`);
    await safeRecorderCall(recorder, "trace", {
      scope: "calendar",
      code: "plan_built",
      message: `Calendar fetched; ${plan.events.length} relevant event(s) and ${plan.dispatches.length} operation(s) planned`,
      data: { eventCount: plan.events.length, plannedOperations: plan.dispatches.length },
    });
    await safeRecorderCall(recorder, "setPlan", plan.dispatches.length);
  } catch (error) {
    // Calendar/plan failures occur before either provider client is called.
    // Preserve their ordinary subsystem diagnostics (including HTTP status)
    // while operation/API failures remain provider-redacted in the executor.
    console.error(`regybox: calendar/plan failed: ${safeErrorMessage(error)}`);
    await safeRecorderCall(recorder, "trace", {
      level: "error",
      scope: "calendar",
      code: "calendar_or_plan_failed",
      message: "Calendar fetch or plan construction failed",
      data: { errorCode: "calendar_or_plan_failure" },
    });
    const operations = [{ operation: "calendar", outcome: "failure", errorCode: "calendar_or_plan_failure" }];
    try {
      await writeLastRun(env.REGYBOX_STATE, {
        ranAt: new Date(now()).toISOString(),
        mode,
        plannedOperations: 0,
        operations,
        ...(platform === "bookr" ? { platform } : {}),
      });
    } catch {
      // Preserve the calendar/build failure as the scheduled-handler error.
    }
    await appendActivity(env.REGYBOX_STATE, [
      {
        at: new Date(now()).toISOString(),
        operation: "calendar",
        outcome: "failure",
        errorCode: "calendar_or_plan_failure",
        ...(platform === "bookr" ? { platform } : {}),
      },
    ]);
    await drainNotifications();
    await safeRecorderCall(recorder, "finalize", {
      status: "failure",
      operations,
      errorCode: "calendar_or_plan_failure",
    });
    throw error;
  }
  let summary;
  try {
    summary = await executePlan({ env, kv: env.REGYBOX_STATE, dispatches: plan.dispatches, now, recorder });
  } catch (error) {
    const failureSummary = error?.[executionSummarySymbol];
    const operations = Array.isArray(failureSummary?.operations) ? failureSummary.operations : [];
    await safeRecorderCall(recorder, "trace", {
      level: "error",
      scope: "executor",
      code: "execution_failed",
      message: "Run execution failed",
      data: { errorCode: "execution_failure" },
    });
    await drainNotifications();
    await safeRecorderCall(recorder, "finalize", {
      status: "failure",
      operations,
      errorCode: "execution_failure",
    });
    throw error;
  }
  // Old email retries must never delay a contested booking attempt.
  await drainNotifications();
  await safeRecorderCall(recorder, "trace", {
    scope: "run",
    code: "run_completed",
    message: `Run completed with ${outcomeStatus(summary.operations)}`,
    data: { outcome: outcomeStatus(summary.operations), plannedOperations: summary.plannedOperations },
  });
  await safeRecorderCall(recorder, "finalize", {
    status: outcomeStatus(summary.operations),
    operations: summary.operations,
  });
  return plan.dispatches.length;
}

// A single Durable Object serializes Bookr scheduler invocations, including
// refresh-token rotation and notification delivery. Unlike a KV lock, this
// works across isolates. Never hold blockConcurrencyWhile across opening waits.
export class BookrCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = Promise.resolve();
  }

  async fetch(request) {
    const { scheduledAt } = await request.json();
    const run = this.pending.then(() => this.run(scheduledAt));
    this.pending = run.catch(() => {});
    await run;
    return new Response("Run complete");
  }

  async run(scheduledAt) {
    return handleScheduled({ ...this.env, REGYBOX_NOTIFICATIONS: this.ctx.storage }, { scheduledAt });
  }
}

export default {
  async scheduled(event, env, _ctx) {
    if (resolvedPlatform(env) === "bookr") {
      if (!env.BOOKR_COORDINATOR) throw new Error("BOOKR_COORDINATOR binding is required; redeploy the current Wrangler configuration");
      const coordinator = env.BOOKR_COORDINATOR.get(env.BOOKR_COORDINATOR.idFromName("bookr-scheduler"));
      const response = await coordinator.fetch("https://coordinator.internal/run", { method: "POST", body: JSON.stringify({ scheduledAt: event?.scheduledTime }) });
      if (!response.ok) throw new Error(`Bookr coordinator failed with HTTP ${response.status}`);
      return;
    }
    await handleScheduled(env, { scheduledAt: event?.scheduledTime });
  },
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    // Browsers request this asset automatically when opening the status page.
    // It is not a status endpoint: in particular, do not let it replace the
    // remembered path prefix with "/favicon.ico".
    if (/\/favicon\.ico$/i.test(url.pathname)) {
      return new Response(null, {
        status: 204,
        headers: {
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }
    const incidentMatch = url.pathname.match(/\/incidents\/([a-f0-9]{36})\/?$/);
    if (incidentMatch) {
      const basePath = url.pathname.slice(0, incidentMatch.index).replace(/\/+$/, "");
      return handleIncidentRequest(env.REGYBOX_STATE, incidentMatch[1], { basePath });
    }
    const runMatch = url.pathname.match(/\/runs\/([a-f0-9]{36})\/?$/);
    if (runMatch) {
      const basePath = url.pathname.slice(0, runMatch.index).replace(/\/+$/, "");
      return handleRunRequest(env.REGYBOX_STATE, runMatch[1], {
        basePath,
        platform: resolvedPlatform(env),
      });
    }
    const runsMatch = url.pathname.match(/\/runs\/?$/);
    if (runsMatch) {
      const basePath = url.pathname.slice(0, runsMatch.index).replace(/\/+$/, "");
      return handleRunsRequest(env.REGYBOX_STATE, {
        basePath,
        platform: resolvedPlatform(env),
      });
    }
    try {
      await rememberStatusOrigin(env.REGYBOX_STATE, url.href);
    } catch (error) {
      console.warn("regybox: status origin write failed:", safeErrorValue(error));
    }
    const basePath = url.pathname.replace(/\/+$/, "");
    return handleStatusRequest(env, env.REGYBOX_STATE, { basePath });
  },
};
