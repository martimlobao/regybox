import { incidentConstants } from "./incidents.js";
import { safeErrorValue } from "./failures.js";

const STATE_TTL_SECONDS = 2592000;
const MAX_APPENDIX_LINES = 12;

function configured(value) {
  return Boolean(String(value ?? "").trim());
}

function operationLabel(operation) {
  return String(operation ?? "").trim().toLowerCase() === "unenroll" ? "unenroll" : "enroll";
}

function providerLabel(platform) {
  return String(platform ?? "").trim().toLowerCase() === "bookr" ? "Bookr.fit" : "Regybox";
}

function dispatchPlatform(dispatch, env) {
  const platform = dispatch?.platform ?? dispatch?.inputs?.["booking-platform"] ?? env?.BOOKING_PLATFORM;
  return String(platform ?? "").trim().toLowerCase() === "bookr" ? "bookr" : "regybox";
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

function trimAppendix(text) {
  const lines = text.split("\n");
  if (lines.length <= MAX_APPENDIX_LINES) {
    return text;
  }
  return [...lines.slice(0, MAX_APPENDIX_LINES - 1), "... (truncated)"].join("\n");
}

function failureSteps(payload) {
  const steps = Array.isArray(payload?.userNextSteps)
    ? payload.userNextSteps.filter((step) => String(step).trim())
    : [];
  return steps.length
    ? steps
    : [
        "Retry the workflow once.",
        "If it fails again, share the technical details with support.",
      ];
}

function emailProvider(env) {
  return String(env?.EMAIL_PROVIDER ?? "smtp").trim().toLowerCase();
}

/** Return whether the selected email transport is configured. */
export function emailConfigured(env) {
  if (emailProvider(env) === "cloudflare") {
    return configured(env?.EMAIL_FROM) && configured(env?.EMAIL_TO) &&
      typeof env?.EMAIL_SENDER?.send === "function";
  }
  if (emailProvider(env) !== "smtp") {
    return false;
  }
  return ["EMAIL_USERNAME", "EMAIL_PASSWORD", "EMAIL_TO"].every((name) => configured(env?.[name]));
}

/** Format the same class summary used by the Python notification helper. */
export function classSummary({ classType, classDate, classTime }) {
  return `${classType} on ${classDate} at ${classTime}`;
}

/** Build the plain-text email content for a completed worker operation. */
export function composeEmail({
  kind,
  operation,
  classSummary: summary,
  payload = {},
  statusUrl,
  incidentUrl,
  runUrl,
  platform = "regybox",
  userIsWaitlisted = false,
}) {
  const operationName = operationLabel(operation);
  const operationNoun = operationName === "unenroll" ? "unenrollment" : "enrollment";
  const label = providerLabel(platform);

  if (kind === "success") {
    const waitlisted = operationName === "enroll" && userIsWaitlisted;
    const bodyLines = [
      waitlisted ? `You have been added to the ${label} waitlist.` : `Your ${label} auto-${operationNoun} completed successfully.`,
      "",
      `Class: ${summary}`,
      "",
      waitlisted ? "Your place in the class is not confirmed. Check the booking platform for waitlist updates." : "No errors were detected.",
    ];
    if (statusUrl) {
      bodyLines.push("", `Status page: ${statusUrl}`);
    }
    if (runUrl) {
      bodyLines.push("", `Run details: ${runUrl}`);
    }
    return {
      subject: `${label} Auto-${operationName}: ${waitlisted ? "waitlisted" : "success"} for ${summary}`,
      body: bodyLines.join("\n"),
    };
  }

  const bodyLines = [
    `We could not complete your ${label} auto-${operationNoun}.`,
    "",
    `Class: ${summary}`,
    "",
    `What happened: ${payload.userMessage}`,
    "",
    "What to do next:",
    ...failureSteps(payload).map((step, index) => `${index + 1}. ${step}`),
  ];
  if (configured(payload.technicalMessage)) {
    bodyLines.push(
      "",
      "Technical details (for support):",
      trimAppendix(`Technical message: ${payload.technicalMessage}`),
    );
  }
  if (incidentUrl) {
    bodyLines.push(
      "",
      `More details (available for ${incidentConstants.INCIDENT_RETENTION_DAYS} days): ${incidentUrl}`,
    );
  }
  if (runUrl) {
    bodyLines.push("", `Run timeline: ${runUrl}`);
  }
  if (statusUrl) {
    bodyLines.push("", `Status page: ${statusUrl}`);
  }
  return {
    subject: `${label} Auto-${operationName}: failure - ${payload.userTitle}`,
    body: bodyLines.join("\n"),
  };
}

/** Send through the selected transport; never retry an ambiguous send through SMTP. */
export async function sendEmail(env, { subject, body }, { mailerFactory, platform = "regybox" } = {}) {
  if (!emailConfigured(env)) {
    throw new Error("Email notification transport is not configured.");
  }
  if (emailProvider(env) === "cloudflare") {
    // Structured EmailMessageBuilder API: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/#interface
    await env.EMAIL_SENDER.send({
      from: {
        name: env.EMAIL_FROM_NAME || `${providerLabel(platform)} Auto-enroll`,
        email: env.EMAIL_FROM.trim(),
      },
      to: env.EMAIL_TO.trim(),
      subject,
      text: body,
    });
    return;
  }
  const createMailer =
    mailerFactory ??
    (async () => {
      const { WorkerMailer } = await import("worker-mailer");
      return WorkerMailer;
    });
  const WorkerMailer = await createMailer();
  const port = Number(env.EMAIL_PORT || 465);
  // The static send() closes the SMTP socket after delivery; keeping a
  // connected instance around would leak a TCP connection per email.
  await WorkerMailer.send(
    {
      host: env.EMAIL_SERVER || "smtp.gmail.com",
      port,
      secure: port === 465,
      credentials: {
        username: env.EMAIL_USERNAME,
        password: env.EMAIL_PASSWORD,
      },
      authType: "plain",
    },
    {
      from: {
        name: env.EMAIL_FROM_NAME || `${providerLabel(platform)} Auto-enroll`,
        email: env.EMAIL_USERNAME,
      },
      to: env.EMAIL_TO,
      subject,
      text: body,
    },
  );
}

/** Persist waitlist delivery separately from the booking cache. */
export async function prepareWaitlistNotification({ env, dispatch, result, statusUrl, runUrl }) {
  const store = env.REGYBOX_NOTIFICATIONS;
  if (!store || !emailConfigured(env) || dispatch.operation !== "enroll" || result.userIsWaitlisted !== true) return null;
  const inputs = dispatch.inputs ?? {};
  const identity = JSON.stringify([dispatchPlatform(dispatch, env), inputs["class-date"], inputs["class-time"], inputs["class-type"]]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const key = `notification:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let record = await store.get(key);
  if (!record) {
    record = {
      state: "pending", expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      dispatch: { operation: "enroll", platform: dispatchPlatform(dispatch, env), inputs: {
        "class-date": inputs["class-date"], "class-time": inputs["class-time"], "class-type": inputs["class-type"],
      } }, statusUrl, runUrl,
    };
    await store.put(key, record);
  }
  return { key, record };
}

/** Drain pending delivery even when the booking planner skips cached classes. */
export async function retryPendingNotifications(env, { onTrace = async () => {}, send = sendEmail } = {}) {
  const store = env.REGYBOX_NOTIFICATIONS;
  if (!store) return;
  const entries = await store.list({ prefix: "notification:", limit: 1000 });
  for (const [key, record] of entries) {
    if (record.expiresAt <= Date.now()) {
      await store.delete(key);
    } else if (record.state === "pending") {
      await notifyResult({ env, dispatch: record.dispatch, result: { status: "success", userIsWaitlisted: true }, statusUrl: record.statusUrl, runUrl: record.runUrl, onTrace, send });
    }
  }
}

/** Notify successful worker results; noops are intentionally silent. */
export async function notifyResult({ env, kv, dispatch, result, statusUrl, runUrl, send = sendEmail, onTrace = async () => {}, now = () => Date.now() }) {
  if (!emailConfigured(env) || (result.status !== "success" && !(result.status === "noop" && result.userIsWaitlisted === true && env.REGYBOX_NOTIFICATIONS))) {
    return;
  }
  const platform = dispatchPlatform(dispatch, env);
  const delivery = await prepareWaitlistNotification({ env, dispatch, result, statusUrl, runUrl });
  if (delivery?.record.state === "sent") return;
  const trace = async (event) => { try { await onTrace(event); } catch { /* best effort */ } };
  const startedAt = now();
  await trace({ scope: "notification", code: "notification_started", message: "Sending confirmation email; the booking result is already verified", data: { userIsWaitlisted: result.userIsWaitlisted === true } });
  try {
    await send(
      env,
      composeEmail({
        kind: "success",
        operation: dispatch.operation,
        classSummary: classSummary({
          classType: dispatch.inputs?.["class-type"],
          classDate: dispatch.inputs?.["class-date"],
          classTime: dispatch.inputs?.["class-time"],
        }),
        statusUrl,
        runUrl,
        platform,
        userIsWaitlisted: result.userIsWaitlisted === true,
      }),
      { platform },
    );
    if (delivery) await env.REGYBOX_NOTIFICATIONS.put(delivery.key, { ...delivery.record, state: "sent" });
    await trace({ scope: "notification", code: "notification_sent", message: "Confirmation email sent", data: { notificationStatus: "sent", durationMs: now() - startedAt } });
    console.log(`regybox: email sent (${dispatch.operation} success)`);
  } catch (error) {
    await trace({ level: "warn", scope: "notification", code: "notification_failed", message: delivery ? "Email delivery failed; the waitlist notice remains queued for retry" : "Confirmation email delivery failed", data: { notificationStatus: delivery ? "pending" : "failed", durationMs: now() - startedAt } });
    console.warn(
      "regybox: success notification email failed:",
      safeErrorValue(error, { platform }),
    );
  }
}

/** Notify failures once per fingerprint, recording dedupe state only after delivery. */
export async function notifyFailure({
  env,
  kv,
  dispatch,
  error,
  payload,
  fingerprint,
  statusUrl,
  incidentUrl,
  runUrl,
  send = sendEmail,
}) {
  if (!emailConfigured(env)) {
    return;
  }

  const platform = dispatchPlatform(dispatch, env);
  const cacheKey = dispatch.inputs?.["cache-key"];
  if (cacheKey && fingerprint) {
    try {
      const cached = parseCachedValue(await kv.get(cacheKey));
      if (cached.failureNotificationFingerprint === fingerprint) {
        console.log("regybox: failure email suppressed (same fingerprint)");
        return;
      }
    } catch (notificationError) {
      console.warn(
        "regybox: failure notification cache read failed:",
        safeErrorValue(notificationError, { platform }),
      );
    }
  }

  try {
    await send(
      env,
      composeEmail({
        kind: "failure",
        operation: dispatch.operation,
        classSummary: classSummary({
          classType: dispatch.inputs?.["class-type"],
          classDate: dispatch.inputs?.["class-date"],
          classTime: dispatch.inputs?.["class-time"],
        }),
        payload,
        statusUrl,
        incidentUrl,
        runUrl,
        platform,
      }),
      { platform },
    );
  } catch (notificationError) {
    console.warn(
      "regybox: failure notification email failed:",
      safeErrorValue(notificationError ?? error, { platform }),
    );
    return;
  }

  if (cacheKey && fingerprint) {
    try {
      const state = parseCachedValue(await kv.get(cacheKey));
      state.failureNotificationFingerprint = fingerprint;
      await kv.put(cacheKey, JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS });
    } catch (notificationError) {
      console.warn(
        "regybox: failure notification cache write failed:",
        safeErrorValue(notificationError, { platform }),
      );
    }
  }
}
