const STATUS_ORIGIN_KEY = "regybox:v1:status_origin";
const INCIDENT_PREFIX = "regybox:v1:incident:";
const INCIDENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TECHNICAL_MESSAGE_LENGTH = 1200;

function configured(value) {
  return Boolean(String(value ?? "").trim());
}

function safeStatusUrl(value) {
  try {
    const url = new URL(String(value));
    if (
      (url.protocol !== "https:" && url.hostname !== "localhost") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function sanitizeText(value, limit = MAX_TECHNICAL_MESSAGE_LENGTH) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "[redacted credential]")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "[redacted credential]")
    .replace(
      /(["']?(?:PHPSESSID|regybox_user|password|token|secret|cookie)["']?\s*[:=]\s*)["']?[^"',}\s;]+["']?/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(PHPSESSID|regybox_user|password|token|secret|cookie)\s+["']?[^"',}\s;]+["']?/gi,
      "$1 [redacted]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/(?:\.\.?\/|\/)?[^\s<>"']+\.php(?:\?[^\s<>"']*)?/gi, "[redacted action URL]")
    .replace(/(?:\.\.?\/|\/)?[^\s<>"']+\.ics(?:\?[^\s<>"']*)?/gi, "[redacted calendar URL]")
    .replace(/([?&][\w.-]+=)[^&\s]+/g, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function safeDiagnostics(error) {
  const diagnostics = error?.safeDiagnostics;
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
    return undefined;
  }
  const result = {};
  for (const key of [
    "actionEndpoints",
    "unknownActionEndpoints",
    "unexpectedOriginEndpoints",
  ]) {
    if (Array.isArray(diagnostics[key])) {
      result[key] = diagnostics[key]
        .slice(0, 10)
        .map((item) => sanitizeText(item, 200));
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function randomIncidentId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function incidentKey(id) {
  return `${INCIDENT_PREFIX}${id}`;
}

export async function rememberStatusOrigin(kv, requestUrl) {
  const statusUrl = safeStatusUrl(requestUrl);
  if (!kv || !statusUrl) {
    return null;
  }
  // The status address is public routing metadata, not a credential. Keep it
  // for the deployment lifetime so set-and-forget users retain incident links.
  if ((await kv.get(STATUS_ORIGIN_KEY)) === statusUrl) {
    return statusUrl;
  }
  await kv.put(STATUS_ORIGIN_KEY, statusUrl);
  return statusUrl;
}

export async function resolveStatusUrl(env, kv) {
  if (configured(env?.STATUS_URL)) {
    const configuredStatusUrl = safeStatusUrl(env.STATUS_URL);
    if (configuredStatusUrl) {
      return configuredStatusUrl;
    }
  }
  if (!kv) {
    return null;
  }
  try {
    return safeStatusUrl(await kv.get(STATUS_ORIGIN_KEY));
  } catch (error) {
    console.warn("regybox: status origin read failed:", error);
    return null;
  }
}

export async function recordIncident({ kv, dispatch, error, payload, statusUrl, now = () => Date.now() }) {
  if (!kv) {
    return null;
  }
  const id = randomIncidentId();
  const inputs = dispatch?.inputs ?? {};
  const record = {
    timestamp: new Date(now()).toISOString(),
    operation: dispatch?.operation === "unenroll" ? "unenroll" : "enroll",
    classCandidates: String(inputs["class-type"] ?? "")
      .split(",")
      .map((value) => sanitizeText(value, 200))
      .filter(Boolean)
      .slice(0, 10),
    classDate: sanitizeText(inputs["class-date"], 20),
    classTime: sanitizeText(inputs["class-time"], 10),
    errorCode: sanitizeText(payload?.errorCode ?? "unexpected_failure", 100),
    errorName: sanitizeText(error?.name ?? "Error", 100),
    technicalMessage: sanitizeText(payload?.technicalMessage ?? error?.message),
  };
  const parserDiagnostics = safeDiagnostics(error);
  if (parserDiagnostics) {
    record.parserDiagnostics = parserDiagnostics;
  }
  await kv.put(incidentKey(id), JSON.stringify(record), { expirationTtl: INCIDENT_TTL_SECONDS });
  const baseUrl = safeStatusUrl(statusUrl);
  return baseUrl ? `${baseUrl}/incidents/${id}` : null;
}

export async function readIncident(kv, id) {
  if (!kv || !/^[a-f0-9]{36}$/.test(String(id))) {
    return null;
  }
  try {
    const value = await kv.get(incidentKey(id));
    if (typeof value !== "string") {
      return null;
    }
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.warn("regybox: incident read failed:", error);
    return null;
  }
}

export const incidentConstants = {
  INCIDENT_TTL_SECONDS,
  INCIDENT_RETENTION_DAYS: INCIDENT_TTL_SECONDS / (24 * 60 * 60),
  STATUS_ORIGIN_KEY,
};
