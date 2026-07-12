import {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
} from "./calendar.js";
import { dispatchWorkflow, executePlan, executionMode, writeLastRun } from "./executor.js";
import { handleStatusRequest } from "./status.js";

export {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
  dispatchWorkflow,
};

export async function handleScheduled(env) {
  let plan;
  try {
    const calendarResponse = await fetch(env.CALENDAR_URL);
    if (!calendarResponse.ok) {
      throw new Error(`Calendar fetch failed: ${calendarResponse.status}`);
    }
    plan = await buildPlan({
      env,
      kv: env.REGYBOX_STATE,
      icsText: await calendarResponse.text(),
    });
  } catch (error) {
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
    throw error;
  }
  await executePlan({ env, kv: env.REGYBOX_STATE, dispatches: plan.dispatches });
  return plan.dispatches.length;
}

export default {
  async scheduled(_event, env, _ctx) {
    await handleScheduled(env);
  },
  async fetch(_request, env, _ctx) {
    return handleStatusRequest(env, env.REGYBOX_STATE);
  },
};
