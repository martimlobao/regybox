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

/** Return whether every SMTP setting required to send notifications is present. */
export function emailConfigured(env) {
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
}) {
  const operationName = operationLabel(operation);
  const operationNoun = operationName === "unenroll" ? "unenrollment" : "enrollment";
  const label = providerLabel(platform);

  if (kind === "success") {
    const bodyLines = [
      `Your ${label} auto-${operationNoun} completed successfully.`,
      "",
      `Class: ${summary}`,
      "",
      "No errors were detected.",
    ];
    if (statusUrl) {
      bodyLines.push("", `Status page: ${statusUrl}`);
    }
    if (runUrl) {
      bodyLines.push("", `Run details: ${runUrl}`);
    }
    return {
      subject: `${label} Auto-${operationName}: success for ${summary}`,
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

/** Send a message through worker-mailer without loading Worker-only sockets under Node. */
export async function sendEmail(env, { subject, body }, { mailerFactory, platform = "regybox" } = {}) {
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

/** Notify successful worker results; noops are intentionally silent. */
export async function notifyResult({ env, kv, dispatch, result, statusUrl, runUrl, send = sendEmail }) {
  if (!emailConfigured(env) || result.status !== "success") {
    return;
  }
  const platform = dispatchPlatform(dispatch, env);
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
      }),
      { platform },
    );
    console.log(`regybox: email sent (${dispatch.operation} success)`);
  } catch (error) {
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
