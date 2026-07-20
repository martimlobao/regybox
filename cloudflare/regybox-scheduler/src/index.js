import {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
  parseClassMap,
  resolveClassRules,
} from "./calendar.js";
import { appendActivity, dispatchWorkflow, executePlan, executionMode, writeLastRun } from "./executor.js";
import { rememberStatusOrigin } from "./incidents.js";
import { createRunRecorder, outcomeStatus } from "./runs.js";
import { handleIncidentRequest, handleRunRequest, handleRunsRequest, handleStatusRequest } from "./status.js";

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
    console.warn(`regybox: run ${method} write failed:`, error);
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

export async function handleScheduled(env, { scheduledAt, now = () => Date.now() } = {}) {
  const mode = resolvedMode(env);
  let recorder = null;
  try {
    recorder = await createRunRecorder({ kv: env.REGYBOX_STATE, mode, scheduledAt, now });
  } catch (error) {
    console.warn("regybox: run recorder start failed:", error);
  }
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
    console.error(`regybox: calendar/plan failed: ${error.message}`);
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
      },
    ]);
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
    const operations = [];
    await safeRecorderCall(recorder, "trace", {
      level: "error",
      scope: "executor",
      code: "execution_failed",
      message: "Run execution failed",
      data: { errorCode: "execution_failure" },
    });
    await safeRecorderCall(recorder, "finalize", {
      status: "failure",
      operations,
      errorCode: "execution_failure",
    });
    throw error;
  }
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

export default {
  async scheduled(event, env, _ctx) {
    await handleScheduled(env, { scheduledAt: event?.scheduledTime });
  },
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const incidentMatch = url.pathname.match(/\/incidents\/([a-f0-9]{36})\/?$/);
    if (incidentMatch) {
      const basePath = url.pathname.slice(0, incidentMatch.index).replace(/\/+$/, "");
      return handleIncidentRequest(env.REGYBOX_STATE, incidentMatch[1], { basePath });
    }
    const runMatch = url.pathname.match(/\/runs\/([a-f0-9]{36})\/?$/);
    if (runMatch) {
      const basePath = url.pathname.slice(0, runMatch.index).replace(/\/+$/, "");
      return handleRunRequest(env.REGYBOX_STATE, runMatch[1], { basePath });
    }
    const runsMatch = url.pathname.match(/\/runs\/?$/);
    if (runsMatch) {
      const basePath = url.pathname.slice(0, runsMatch.index).replace(/\/+$/, "");
      return handleRunsRequest(env.REGYBOX_STATE, { basePath });
    }
    try {
      await rememberStatusOrigin(env.REGYBOX_STATE, url.href);
    } catch (error) {
      console.warn("regybox: status origin write failed:", error);
    }
    const basePath = url.pathname.replace(/\/+$/, "");
    return handleStatusRequest(env, env.REGYBOX_STATE, { basePath });
  },
};
