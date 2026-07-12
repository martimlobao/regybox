import {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
} from "./calendar.js";

export {
  buildPlan,
  defaultLookaheadHours,
  expandCalendarEvents,
  normalizeList,
};

async function dispatchWorkflow(env, dispatch) {
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

async function handleScheduled(env) {
  const calendarResponse = await fetch(env.CALENDAR_URL);
  if (!calendarResponse.ok) {
    throw new Error(`Calendar fetch failed: ${calendarResponse.status}`);
  }
  const plan = await buildPlan({
    env,
    kv: env.REGYBOX_STATE,
    icsText: await calendarResponse.text(),
  });
  for (const dispatch of plan.dispatches) {
    await dispatchWorkflow(env, dispatch);
  }
  return plan.dispatches.length;
}

export default {
  async scheduled(_event, env, _ctx) {
    await handleScheduled(env);
  },
  async fetch(_request, _env, _ctx) {
    return new Response("Regybox scheduler Worker is healthy.\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
