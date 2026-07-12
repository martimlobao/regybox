import { defaultLookaheadHours, expandCalendarEvents, resolveClassRules } from "./calendar.js";
import { executionMode, readLastRun } from "./executor.js";
import { emailConfigured } from "./notify.js";
import { RegyboxLoginError, createRegyboxClient } from "./regybox.js";

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

function setupChecks(env) {
  const checks = [];
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
  if (events.length === 0) {
    return check(
      "warn",
      `Calendar is reachable, but no “${names}” events in the next ${lookaheadHours} hours`,
      `${bookingRules ? `Booking rules: ${bookingRules}. ` : ""}` +
        "The scheduler only books classes that are on your calendar. Check that your event titles match the booking rules exactly.",
    );
  }
  return check(
    "ok",
    `Calendar is reachable — ${events.length} upcoming “${names}” ` +
      `event${events.length === 1 ? "" : "s"} in the next ${lookaheadHours} hours`,
    bookingRules ? `Booking rules: ${bookingRules}` : undefined,
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
      `Last check: ${when} — ${failures.map(describeOperation).join("; ")}`,
      "See the checks above for what to fix, or check the Worker logs in Cloudflare for details.",
    );
  }
  if (operations.length === 0) {
    return check("ok", `Last check: ${when} — nothing to do`);
  }
  return check("ok", `Last check: ${when} — ${operations.map(describeOperation).join("; ")}`);
}

export async function buildStatusModel({
  env,
  kv,
  fetchImpl = fetch,
  createClient = createRegyboxClient,
  now = () => Date.now(),
}) {
  const nowMs = now();
  let mode;
  try {
    mode = executionMode(env) === "dispatch" ? "GitHub dispatch" : "self-contained";
  } catch {
    mode = "not configured yet";
  }
  const liveChecks = (
    await Promise.all([
      regyboxCheck(env, { createClient, nowMs }),
      calendarCheck(env, { fetchImpl, nowMs }),
    ])
  ).filter(Boolean);
  let lastRun = null;
  try {
    lastRun = kv ? await readLastRun(kv) : null;
  } catch {
    lastRun = null;
  }
  return {
    mode,
    generatedAt: new Date(nowMs).toISOString(),
    sections: [
      { title: "Setup", checks: setupChecks(env) },
      { title: "Live checks", checks: liveChecks },
      {
        title: "Last run",
        checks: [lastRunCheck(lastRun && Object.keys(lastRun).length > 0 ? lastRun : null, nowMs)],
      },
    ],
  };
}

export function renderStatusPage(model) {
  const sections = model.sections
    .filter((section) => section.checks.length > 0)
    .map((section) => {
      const rows = section.checks
        .map(
          (item) =>
            `      <li class="${item.level}">${escapeHtml(item.text)}${
              item.hint ? `<span class="hint">${escapeHtml(item.hint)}</span>` : ""
            }</li>`,
        )
        .join("\n");
      return `    <h2>${escapeHtml(section.title)}</h2>\n    <ul>\n${rows}\n    </ul>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Regybox auto-enroller — status</title>
<style>${STYLES}</style>
</head>
<body>
  <h1>Regybox auto-enroller</h1>
  <p class="sub">Setup checklist — refresh this page after changing settings.</p>
${sections}
  <footer>Mode: ${escapeHtml(model.mode)} · checked ${escapeHtml(model.generatedAt)} ·
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
