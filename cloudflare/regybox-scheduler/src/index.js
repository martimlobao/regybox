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
import { handleIncidentRequest, handleStatusRequest } from "./status.js";

export {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
  parseClassMap,
  resolveClassRules,
  dispatchWorkflow,
};

export async function handleScheduled(env) {
  let plan;
  try {
    console.log("regybox: calendar fetch started");
    const calendarResponse = await fetch(env.CALENDAR_URL);
    if (!calendarResponse.ok) {
      throw new Error(`Calendar fetch failed: ${calendarResponse.status}`);
    }
    plan = await buildPlan({
      env,
      kv: env.REGYBOX_STATE,
      icsText: await calendarResponse.text(),
    });
    console.log(`regybox: calendar fetched, ${plan.events.length} events in window`);
    console.log(`regybox: plan built, ${plan.dispatches.length} operation(s)`);
  } catch (error) {
    console.error(`regybox: calendar/plan failed: ${error.message}`);
    const mode = (() => {
      try {
        return executionMode(env);
      } catch {
        return "unconfigured";
      }
    })();
    try {
      await writeLastRun(env.REGYBOX_STATE, {
        ranAt: new Date().toISOString(),
        mode,
        plannedOperations: 0,
        operations: [{ operation: "calendar", outcome: "failure", errorCode: "calendar_or_plan_failure" }],
      });
    } catch {
      // Preserve the calendar/build failure as the scheduled-handler error.
    }
    await appendActivity(env.REGYBOX_STATE, [
      {
        at: new Date().toISOString(),
        operation: "calendar",
        outcome: "failure",
        errorCode: "calendar_or_plan_failure",
      },
    ]);
    throw error;
  }
  await executePlan({ env, kv: env.REGYBOX_STATE, dispatches: plan.dispatches });
  return plan.dispatches.length;
}

export default {
  async scheduled(_event, env, _ctx) {
    await handleScheduled(env);
  },
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const incidentMatch = url.pathname.match(/^\/incidents\/([a-f0-9]{36})\/?$/);
    if (incidentMatch) {
      return handleIncidentRequest(env.REGYBOX_STATE, incidentMatch[1]);
    }
    try {
      await rememberStatusOrigin(env.REGYBOX_STATE, url.origin);
    } catch (error) {
      console.warn("regybox: status origin write failed:", error);
    }
    return handleStatusRequest(env, env.REGYBOX_STATE);
  },
};
