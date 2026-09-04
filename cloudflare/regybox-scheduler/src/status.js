import { defaultLookaheadHours, expandCalendarEvents, resolveClassRules } from "./calendar.js";
import { executionMode, readActivity, readLastRun } from "./executor.js";
import { emailConfigured } from "./notify.js";
import { RegyboxLoginError, createRegyboxClient } from "./regybox.js";
import { incidentConstants, readIncident } from "./incidents.js";
import { readRun, readRuns, runConstants } from "./runs.js";
import { bookingPlatform, platformLabel } from "./platform.js";
import {
  BookrSessionRefreshRequiredError,
  BookrSubscriptionError,
  createBookrClient as defaultBookrClient,
} from "./bookr.js";

const STYLES = `
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem;
    color: #1a1a1a; background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #111; }
    .hint, .sub, footer { color: #9a9a9a; }
    li { border-color: #2a2a2a; }
  }
  h1 { font-size: 1.35rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
  .sub { color: #777; margin-top: 0; }
  ul { list-style: none; padding: 0; margin: 0.25rem 0; }
  li { padding: 0.6rem 0.2rem; border-bottom: 1px solid #eee; }
  .ok::before   { content: "\\2705\\00a0 "; }
  .bad::before  { content: "\\274C\\00a0 "; }
  .warn::before { content: "\\26A0\\FE0F\\00a0 "; }
  .off::before  { content: "\\2796\\00a0 "; }
  .hint { display: block; color: #777; font-size: 0.88rem; margin-top: 0.15rem; }
  footer { margin-top: 2rem; color: #777; font-size: 0.85rem; }
  a { color: inherit; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
  th, td { padding: 0.55rem 0.35rem; text-align: left; vertical-align: top; border-bottom: 1px solid #eee; }
  th { font-size: 0.85rem; color: #777; }
  code, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function configured(value) {
  return Boolean(String(value ?? "").trim());
}

function dispatchConfigured(env) {
  return ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].every((name) => configured(env?.[name]));
}

function check(level, text, hint) {
  return hint ? { level, text, hint } : { level, text };
}

function relativeTime(isoString, nowMs) {
  const then = Date.parse(String(isoString ?? ""));
  if (!Number.isFinite(then)) {
    return null;
  }
  const minutes = Math.round((nowMs - then) / 60_000);
  if (minutes < 1) {
    return "moments ago";
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return `${Math.round(hours / 24)} days ago`;
}

function setupChecks(env, platform = "regybox") {
  const checks = [];
  if (platform === "invalid") {
    checks.push(
      check(
        "bad",
        "Booking platform is invalid",
        "Set BOOKING_PLATFORM to regybox or bookr, then refresh this page.",
      ),
    );
  } else if (platform === "bookr") {
    checks.push(check("ok", "Booking platform: Bookr.fit"));
    if (configured(env.BOOKR_AUTH_COOKIE)) {
      checks.push(check("ok", "Bookr.fit authentication cookie is set"));
    } else {
      checks.push(
        check(
          "bad",
          "Bookr.fit authentication cookie is missing",
          "Sign in at bookr.fit, copy every sb-…-auth-token cookie chunk, and add the " +
            "complete semicolon-separated value as BOOKR_AUTH_COOKIE under Settings → Variables and Secrets.",
        ),
      );
    }
    if (dispatchConfigured(env)) {
      checks.push(
        check(
          "bad",
          "Bookr.fit requires self-contained Worker execution",
          "Remove the GitHub dispatch variables (GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO), then refresh this page.",
        ),
      );
    }
  } else {
    if (configured(env.PHPSESSID) && configured(env.REGYBOX_USER)) {
      checks.push(check("ok", "Regybox cookies are set"));
    } else {
      checks.push(
        check(
          "bad",
          "Regybox cookies are missing",
          "Add PHPSESSID and REGYBOX_USER under Settings → Variables and Secrets. " +
            "Copy both values from regybox.pt using your browser's developer tools.",
        ),
      );
    }
  }
  if (configured(env.CALENDAR_URL)) {
    checks.push(check("ok", "Calendar link is set"));
  } else {
    checks.push(
      check(
        "bad",
        "Calendar link is missing",
        "Add CALENDAR_URL — the “Secret address in iCal format” from " +
          "Google Calendar → Settings → Integrate calendar.",
      ),
    );
  }
  if (configured(env.CLASS_MAP)) {
    try {
      resolveClassRules(env);
    } catch (error) {
      checks.push(
        check(
          "bad",
          `CLASS_MAP is invalid: ${error.message}`,
          "Use rules such as CrossFit = WOD; Weightlifting = Weightlifting Rato, Strength.",
        ),
      );
    }
  }
  if (emailConfigured(env)) {
    checks.push(check("ok", "Email notifications are on"));
  } else {
    checks.push(
      check(
        "off",
        "Email notifications are off",
        "Optional. Add EMAIL_USERNAME, EMAIL_PASSWORD and EMAIL_TO to get an email " +
          "when you are enrolled or when something needs your attention.",
      ),
    );
  }
  return checks;
}

async function calendarCheck(env, { fetchImpl, nowMs }) {
  if (!configured(env.CALENDAR_URL)) {
    return null;
  }
  let classRules;
  try {
    classRules = resolveClassRules(env);
  } catch (error) {
    return check(
      "bad",
      `Calendar booking rules are invalid: ${error.message}`,
      "Use rules such as CrossFit = WOD; Weightlifting = Weightlifting Rato, Strength.",
    );
  }
  const eventNames = classRules.map((rule) => rule.eventName);
  const lookaheadHours = defaultLookaheadHours(env);
  let response;
  try {
    response = await fetchImpl(env.CALENDAR_URL);
  } catch {
    return check(
      "bad",
      "Calendar could not be fetched",
      "The calendar link did not respond. Check that CALENDAR_URL is the full secret iCal address.",
    );
  }
  if (!response.ok) {
    return check(
      "bad",
      `Calendar could not be fetched (HTTP ${response.status})`,
      "The link may have been reset. Copy a fresh secret iCal address from your calendar settings.",
    );
  }
  let events;
  try {
    events = expandCalendarEvents({
      icsText: await response.text(),
      now: new Date(nowMs),
      lookaheadHours,
      classRules,
      timeZone: env.TIMEZONE || "Europe/Lisbon",
    });
  } catch {
    return check(
      "bad",
      "Calendar was fetched but could not be read",
      "The link does not look like an iCal feed. Use the “Secret address in iCal format” link.",
    );
  }
  const names = eventNames.join(", ");
  const bookingRules = configured(env.CLASS_MAP)
    ? classRules
        .map(({ eventName, classType }) => {
          const [primary, ...fallbacks] = classType.split(", ");
          return `${eventName} → ${primary}${fallbacks.length ? ` (backup: ${fallbacks.join(", ")})` : ""}`;
        })
        .join(" · ")
    : null;
  const bookrCompatibility = bookingPlatform(env) === "bookr"
    ? "Bookr.fit also matches a configured class ending in the exact box name to its separated class title and box (for example, WOD Rato → WOD at Rato)."
    : null;
  if (events.length === 0) {
    return check(
      "warn",
      `Calendar is reachable, but no “${names}” events in the next ${lookaheadHours} hours`,
      [
        bookingRules ? `Booking rules: ${bookingRules}.` : null,
        bookrCompatibility,
        "The scheduler only books classes that are on your calendar. Check that your event titles match the booking rules exactly.",
      ].filter(Boolean).join(" "),
    );
  }
  return check(
    "ok",
    `Calendar is reachable — ${events.length} upcoming “${names}” ` +
      `event${events.length === 1 ? "" : "s"} in the next ${lookaheadHours} hours`,
    [
      bookingRules ? `Booking rules: ${bookingRules}` : null,
      bookrCompatibility,
    ].filter(Boolean).join(" ") || undefined,
  );
}

async function regyboxCheck(env, { createClient, nowMs }) {
  if (!configured(env.PHPSESSID) || !configured(env.REGYBOX_USER)) {
    return null;
  }
  try {
    const client = createClient({
      phpsessid: env.PHPSESSID,
      regyboxUser: env.REGYBOX_USER,
      timezone: env.TIMEZONE || "Europe/Lisbon",
      retryTotal: 1,
    });
    await client.fetchClassesHtml(nowMs);
    return check("ok", "Regybox accepts your login");
  } catch (error) {
    if (error instanceof RegyboxLoginError || error?.name === "RegyboxLoginError") {
      return check(
        "bad",
        "Regybox rejected your login — the saved cookie has expired",
        "Sign in at regybox.pt again, copy the new PHPSESSID value, and update it " +
          "under Settings → Variables and Secrets.",
      );
    }
    return check(
      "warn",
      "Regybox could not be reached right now",
      "This is usually temporary. Refresh this page in a minute.",
    );
  }
}

function activeSubscriptionId(value) {
  const candidates = [
    value?.subscriptionId,
    value?.activeSubscriptionId,
    value?.activeSubscription?.id,
    value?.subscription?.id,
  ];
  return candidates.find((candidate) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(candidate ?? "")),
  ) ?? null;
}

function isBookrLoginError(error) {
  return /bookr.*(?:login|auth|session)|auth.*bookr/i.test(String(error?.name ?? "")) ||
    error?.code === "BOOKR_AUTH_ERROR" || error?.status === 401 || error?.status === 403;
}

function isBookrRefreshRequiredError(error) {
  return error instanceof BookrSessionRefreshRequiredError ||
    error?.name === "BookrSessionRefreshRequiredError";
}

async function bookrCheck(env, { createClient, nowMs, kv }) {
  if (!configured(env.BOOKR_AUTH_COOKIE)) {
    return [];
  }
  try {
    const client = createClient({
      authCookie: env.BOOKR_AUTH_COOKIE,
      kv,
      timezone: env.TIMEZONE || "Europe/Lisbon",
      now: () => nowMs,
      // A status refresh may validate the live session, but it must not update
      // the stored browser session or otherwise change booking state.
      persistSession: false,
    });
    const session = await client.bootstrapSession();
    const subscriptionId = activeSubscriptionId(session) || activeSubscriptionId(client);
    return [
      check("ok", "Bookr.fit accepts your login"),
      subscriptionId
        ? check("ok", "Bookr.fit has an active subscription")
        : check(
            "bad",
            "Bookr.fit has no active subscription",
            "Check that your Bookr.fit membership is active and refresh this page.",
          ),
    ];
  } catch (error) {
    if (isBookrRefreshRequiredError(error)) {
      return [
        check(
          "warn",
          "Bookr.fit session needs refresh",
          "The saved session is still structurally valid, but its access token is expiring. " +
            "This read-only status check did not rotate it; the scheduler will refresh it on its next run.",
        ),
      ];
    }
    if (error instanceof BookrSubscriptionError || error?.name === "BookrSubscriptionError") {
      return [
        check("ok", "Bookr.fit accepts your login"),
        check(
          "bad",
          "Bookr.fit has no active subscription",
          "Check that your Bookr.fit membership is active and refresh this page.",
        ),
      ];
    }
    if (isBookrLoginError(error)) {
      return [
        check(
          "bad",
          "Bookr.fit rejected your login — the saved session has expired",
          "Sign in at bookr.fit again, copy every numbered sb-…-auth-token cookie chunk, and update BOOKR_AUTH_COOKIE under Settings → Variables and Secrets.",
        ),
      ];
    }
    return [
      check(
        "warn",
        "Bookr.fit could not be reached right now",
        "This is usually temporary. Refresh this page in a minute.",
      ),
    ];
  }
}

function describeOperation(operation) {
  if (!operation.classDate || !operation.classTime) {
    return operation.outcome === "failure"
      ? `the calendar could not be checked (${operation.errorCode || "unknown error"})`
      : `${operation.operation} ran without class details`;
  }
  const what = `${operation.classType || "class"} on ${operation.classDate} at ${operation.classTime}`;
  switch (operation.outcome) {
    case "success":
      return operation.operation === "unenroll" ? `unenrolled from ${what}` : `enrolled in ${what}`;
    case "dispatched":
      return `asked GitHub to ${operation.operation} ${what}`;
    case "noop":
      return `nothing to change for ${what}`;
    case "skipped":
      return `ran out of time before handling ${what}`;
    default:
      return `${operation.operation} ${what} failed (${operation.errorCode || "unknown error"})`;
  }
}

function recordPlatform(record) {
  return record?.platform === "bookr" ? "bookr" : "regybox";
}

function recordLabel(record) {
  return recordPlatform(record) === "bookr" ? "Bookr.fit" : "Regybox";
}

function recordPrefix(record) {
  return recordPlatform(record) === "bookr" ? "Bookr.fit: " : "";
}

function lastRunCheck(lastRun, nowMs) {
  if (!lastRun || !lastRun.ranAt) {
    return check(
      "warn",
      "The scheduler has not run yet",
      "The first check runs at 28 or 58 minutes past the hour. Refresh this page after that.",
    );
  }
  const when = relativeTime(lastRun.ranAt, nowMs) ?? lastRun.ranAt;
  const operations = Array.isArray(lastRun.operations) ? lastRun.operations : [];
  const failures = operations.filter((operation) => operation.outcome === "failure");
  if (failures.length > 0) {
    return check(
      "bad",
      `Last check: ${when} — ${recordPrefix(lastRun)}${failures.map(describeOperation).join("; ")}`,
      "See the checks above for what to fix, or check the Worker logs in Cloudflare for details.",
    );
  }
  if (lastRun.status === "failure") {
    return check(
      "bad",
      `Last check: ${when} — ${recordPrefix(lastRun)}scheduler run failed`,
      "See the checks above for what to fix, or check the Worker logs in Cloudflare for details.",
    );
  }
  if (operations.length === 0) {
    return check("ok", `Last check: ${when} — ${recordPrefix(lastRun)}nothing to do`);
  }
  return check("ok", `Last check: ${when} — ${recordPrefix(lastRun)}${operations.map(describeOperation).join("; ")}`);
}

function activityCheck(activity, nowMs) {
  const when = relativeTime(activity.at, nowMs) ?? activity.at;
  const description = describeOperation(activity);
  const text = `${recordPrefix(activity)}${description.charAt(0).toUpperCase()}${description.slice(1)} — ${when}`;
  const level = activity.outcome === "success" ? "ok" : activity.outcome === "failure" ? "bad" : "off";
  return check(level, text);
}

function runLevel(status) {
  if (status === "failure") return "bad";
  if (status === "partial" || status === "running") return "warn";
  if (status === "success") return "ok";
  return "off";
}

function durationText(durationMs) {
  if (!Number.isFinite(durationMs)) return "still running";
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function baseHref(basePath, suffix = "") {
  const base = String(basePath ?? "").replace(/\/+$/, "");
  return `${base}${suffix}` || "/";
}

function runCheck(run, nowMs, basePath) {
  const when = relativeTime(run.startedAt, nowMs) ?? run.startedAt;
  const operations = Array.isArray(run.operations) ? run.operations : [];
  const operationText = operations.length > 0
    ? operations.map(describeOperation).join("; ")
    : run.status === "running" ? "run is still in progress" : "nothing to do";
  return {
    ...check(
      runLevel(run.status),
      `${when} — ${recordPrefix(run)}${run.status} in ${durationText(run.durationMs)} — ${operationText}`,
      run.traceTruncated ? "The retained trace reached its 500-event limit." : undefined,
    ),
    href: baseHref(basePath, `/runs/${run.id}`),
  };
}

export async function buildStatusModel({
  env,
  kv,
  fetchImpl = fetch,
  createClient = createRegyboxClient,
  createBookrClient = defaultBookrClient,
  now = () => Date.now(),
  basePath = "",
}) {
  const nowMs = now();
  let platform = "regybox";
  try {
    platform = bookingPlatform(env);
  } catch {
    platform = configured(env?.BOOKING_PLATFORM) ? "invalid" : "regybox";
  }
  let mode;
  try {
    mode = executionMode(env) === "dispatch" ? "GitHub dispatch" : "self-contained";
  } catch {
    mode = "not configured yet";
  }
  const liveChecks = (
    platform === "bookr"
      ? await Promise.all([
          bookrCheck(env, { createClient: createBookrClient, nowMs, kv }),
          calendarCheck(env, { fetchImpl, nowMs }),
        ])
      : platform === "regybox"
        ? await Promise.all([
            regyboxCheck(env, { createClient, nowMs }),
            calendarCheck(env, { fetchImpl, nowMs }),
          ])
        : []
  ).flat().filter(Boolean);
  let lastRun = null;
  try {
    lastRun = kv ? await readLastRun(kv) : null;
  } catch {
    lastRun = null;
  }
  let activity = [];
  try {
    activity = kv ? await readActivity(kv) : [];
  } catch {
    activity = [];
  }
  let runs = [];
  try {
    runs = kv ? await readRuns(kv) : [];
  } catch {
    runs = [];
  }
  const sections = [
    { title: "Setup", checks: setupChecks(env, platform) },
    { title: "Live checks", checks: liveChecks },
    {
      title: "Last run",
      checks: [lastRunCheck(lastRun && Object.keys(lastRun).length > 0 ? lastRun : null, nowMs)],
    },
  ];
  if (activity.length > 0) {
    sections.push({
      title: "Recent activity",
      checks: activity.slice(0, 10).map((entry) => activityCheck(entry, nowMs)),
    });
  }
  if (runs.length > 0) {
    sections.push({
      title: "Recent runs",
      checks: runs.slice(0, 10).map((run) => runCheck(run, nowMs, basePath)),
      moreHref: baseHref(basePath, "/runs"),
    });
  }
  return {
    platform,
    platformLabel: platform === "invalid" ? "Unknown" : platformLabel(platform),
    mode,
    generatedAt: new Date(nowMs).toISOString(),
    sections,
  };
}

export function renderStatusPage(model) {
  const label = model.platform === "invalid" ? "Unknown" : platformLabel(model.platform);
  const title = `${label} auto-enroller`;
  const sections = model.sections
    .filter((section) => section.checks.length > 0)
    .map((section) => {
      const rows = section.checks
        .map(
          (item) =>
            `      <li class="${item.level}">${item.href ? `<a href="${escapeHtml(item.href)}">` : ""}${escapeHtml(item.text)}${item.href ? "</a>" : ""}${
              item.hint ? `<span class="hint">${escapeHtml(item.hint)}</span>` : ""
            }</li>`,
        )
        .join("\n");
      return `    <h2>${escapeHtml(section.title)}</h2>\n    <ul>\n${rows}\n    </ul>${section.moreHref ? `\n    <p><a href="${escapeHtml(section.moreHref)}">View all retained runs</a></p>` : ""}`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} — status</title>
<style>${STYLES}</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">Setup checklist — refresh this page after changing settings.</p>
${sections}
  <footer>Mode: ${escapeHtml(model.mode)}${model.platform === "bookr" || model.platform === "invalid" ? ` · ${escapeHtml(label)}` : ""} · checked ${escapeHtml(model.generatedAt)} ·
  this page is read-only and never shows your credentials.</footer>
</body>
</html>`;
}

export async function handleStatusRequest(env, kv, options = {}) {
  const model = await buildStatusModel({ env, kv, ...options });
  return new Response(renderStatusPage(model), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export function renderRunsPage(runs, { basePath = "", nowMs = Date.now(), platform = "regybox" } = {}) {
  const label = platform === "bookr" ? "Bookr.fit" : "Regybox";
  const currentPlatform = platform === "bookr" ? "bookr" : "regybox";
  const showPlatform = runs.some((run) => recordPlatform(run) !== currentPlatform);
  const rows = runs.map((run) => {
    const operations = Array.isArray(run.operations) ? run.operations : [];
    const summary = operations.length > 0 ? operations.map(describeOperation).join("; ") : "nothing to do";
    const runLabel = run?.platform === "bookr" ? "Bookr.fit" : "Regybox";
    return `    <tr>
      <td><a href="${escapeHtml(baseHref(basePath, `/runs/${run.id}`))}">${escapeHtml(relativeTime(run.startedAt, nowMs) ?? run.startedAt)}</a></td>
      ${showPlatform ? `<td>${escapeHtml(runLabel)}</td>` : ""}
      <td>${escapeHtml(run.status)}</td>
      <td>${escapeHtml(durationText(run.durationMs))}</td>
      <td>${escapeHtml(summary)}</td>
    </tr>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(label)} run history</title>
<style>${STYLES}</style>
</head>
<body>
  <h1>${escapeHtml(label)} run history</h1>
  <p class="sub">Sanitized timelines are retained for ${runConstants.RUN_RETENTION_DAYS} days.</p>
  <p><a href="${escapeHtml(baseHref(basePath))}">Back to status</a></p>
  ${rows ? `<table><thead><tr><th>Started</th>${showPlatform ? "<th>Platform</th>" : ""}<th>Status</th><th>Duration</th><th>Operations</th></tr></thead><tbody>\n${rows}\n  </tbody></table>` : "<p>No retained runs yet.</p>"}
  <footer>This read-only history never includes credentials, calendar contents, raw HTML, or complete action URLs.</footer>
</body>
</html>`;
}

export function renderRunPage(run, { basePath = "", platform = "regybox" } = {}) {
  const label = recordLabel(run);
  const operations = Array.isArray(run.operations) ? run.operations : [];
  const operationRows = operations.map((operation, index) =>
    `    <tr><td>${index + 1}</td><td>${escapeHtml(describeOperation(operation))}</td><td>${escapeHtml(operation.outcome)}</td></tr>`,
  ).join("\n");
  const trace = Array.isArray(run.trace) ? run.trace : [];
  const traceRows = trace.map((event) => {
    const data = event.data && Object.keys(event.data).length > 0 ? JSON.stringify(event.data) : "";
    return `    <tr>
      <td>${escapeHtml(event.at)}</td>
      <td>${escapeHtml(`${event.elapsedMs}ms`)}</td>
      <td>${escapeHtml(event.level)}</td>
      <td>${escapeHtml(event.scope)}${Number.isInteger(event.operationIndex) ? ` #${event.operationIndex + 1}` : ""}</td>
      <td><strong>${escapeHtml(event.message)}</strong>${data ? `<span class="hint"><code>${escapeHtml(data)}</code></span>` : ""}</td>
    </tr>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(label)} run details</title>
<style>${STYLES}</style>
</head>
<body>
  <h1>${escapeHtml(label)} run details</h1>
  <p class="sub">Run ${escapeHtml(run.id)} · ${escapeHtml(run.status)} · ${escapeHtml(durationText(run.durationMs))}</p>
  <p><a href="${escapeHtml(baseHref(basePath, "/runs"))}">Back to run history</a></p>
  <dl>
    <dt>Scheduled</dt><dd>${escapeHtml(run.scheduledAt)}</dd>
    <dt>Started</dt><dd>${escapeHtml(run.startedAt)}</dd>
    ${run.finishedAt ? `<dt>Finished</dt><dd>${escapeHtml(run.finishedAt)}</dd>` : ""}
    <dt>Mode</dt><dd>${escapeHtml(run.mode)}</dd>
  </dl>
  <h2>Operations</h2>
  ${operationRows ? `<table><thead><tr><th>#</th><th>Summary</th><th>Outcome</th></tr></thead><tbody>\n${operationRows}\n  </tbody></table>` : "<p>No operations were planned.</p>"}
  <h2>Timeline</h2>
  ${traceRows ? `<table><thead><tr><th>Time</th><th>Elapsed</th><th>Level</th><th>Scope</th><th>Event</th></tr></thead><tbody>\n${traceRows}\n  </tbody></table>` : "<p>No trace events were retained.</p>"}
  ${run.traceTruncated ? `<p class="warn">Trace truncated after ${runConstants.MAX_TRACE_EVENTS} events.</p>` : ""}
  <footer>This page is read-only. Trace fields are allowlisted and sanitized before storage.</footer>
</body>
</html>`;
}

export async function handleRunsRequest(kv, options = {}) {
  return htmlResponse(renderRunsPage(await readRuns(kv), options));
}

export async function handleRunRequest(kv, id, options = {}) {
  const run = await readRun(kv, id);
  if (!run) {
    return new Response("Run not found or expired.", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }
  return htmlResponse(renderRunPage(run, options));
}

export function renderIncidentPage(incident, { basePath = "", platform = incident?.platform || "regybox" } = {}) {
  const label = platform === "bookr" ? "Bookr.fit" : "Regybox";
  const rows = [
    ["Time", incident.timestamp],
    ["Operation", incident.operation],
    ["Class candidates", Array.isArray(incident.classCandidates) ? incident.classCandidates.join(", ") : ""],
    ["Class date", incident.classDate],
    ["Class time", incident.classTime],
    ["Error code", incident.errorCode],
    ["Error type", incident.errorName],
    ["Technical message", incident.technicalMessage],
  ];
  if (incident.parserDiagnostics) {
    rows.push(["Safe parser diagnostics", JSON.stringify(incident.parserDiagnostics, null, 2)]);
  }
  if (incident.platform) {
    rows.splice(1, 0, ["Platform", incident.platform === "bookr" ? "Bookr.fit" : "Regybox"]);
  }
  const details = rows
    .filter(([, value]) => String(value ?? "").trim())
    .map(
      ([label, value]) =>
        `  <dt>${escapeHtml(label)}</dt>\n  <dd><pre>${escapeHtml(value)}</pre></dd>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(label)} incident details</title>
<style>${STYLES}
  dt { font-weight: 650; margin-top: 1rem; }
  dd { margin: 0.2rem 0 0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
</style>
</head>
<body>
  <h1>${escapeHtml(label)} incident details</h1>
  <p class="sub">This sanitized diagnostic record expires automatically after ${incidentConstants.INCIDENT_RETENTION_DAYS} days.</p>
  <dl>
${details}
  </dl>
  ${incident.runId ? `<p><a href="${escapeHtml(baseHref(basePath, `/runs/${incident.runId}`))}">View the complete run timeline</a></p>` : ""}
  <footer>This page is read-only. It never stores or displays credentials, full action URLs, or query tokens.</footer>
</body>
</html>`;
}

export async function handleIncidentRequest(kv, id, options = {}) {
  const incident = await readIncident(kv, id);
  if (!incident) {
    return new Response("Incident not found or expired.", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }
  return new Response(renderIncidentPage(incident, options), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
