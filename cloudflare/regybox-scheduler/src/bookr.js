import {
  ClassIsOverbookedError,
  ClassNotFoundError,
  ClassNotOpenError,
  RegyboxTimeoutError,
  UnparseableError,
  parseClassTypes,
  defaultSleep,
} from "./regybox.js";

// The adapter deliberately only knows about these first-party endpoints.  In
// particular, it never follows a URL supplied by a Bookr response.
const BOOKR_ORIGIN = "https://bookr.fit";
const SUPABASE_ORIGIN = "https://jphimrpybgssduyuziaw.supabase.co";
// Public browser key shipped in Bookr.fit's own dashboard bundle. It identifies
// the Supabase project; authorization still comes exclusively from the user's
// access and refresh tokens.
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_JuWdfAk6mf9Yt75um1Gv6A_5sdMSIAk";
const AUTH_COOKIE = "sb-jphimrpybgssduyuziaw-auth-token";
const MAX_COOKIE_CHUNKS = 16;
const COOKIE_CHUNK_SIZE = 3180;
const MAX_RESPONSE_BYTES = 512 * 1024;
const OPENING_BOUNDARY_GRACE_MS = 30_000;
const MAX_REFRESH_ATTEMPTS = 3;
const defaultRefreshBackoffMs = (attempt) => attempt * 250;
const AUTH_KV_KEY = "regybox:v2:bookr:auth";
const BOOKR_POST_RESPONSE_FAILURE = Symbol("bookrPostResponseFailure");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLASS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_ERROR_CODES = new Set([
  "booking_daily_category_limit_exceeded",
  "booking_overlapping_session",
  "booking_pack_limit_exceeded",
  "booking_restricted",
  "booking_weekly_limit_exceeded",
  "booking_window_not_open",
  "cancellation_window_closed",
  "no_show_penalty_active",
  "registration_deadline_passed",
  "subscription_not_valid_for_session",
  "waitlist_full",
]);

export class BookrLoginError extends Error {
  constructor(message = "Unable to log in to Bookr.fit", status = null) {
    super(message);
    this.name = "BookrLoginError";
    this.status = Number.isInteger(status) ? status : null;
  }
}

export class BookrSessionRefreshRequiredError extends Error {
  constructor() {
    super("Bookr session is valid but needs refresh");
    this.name = "BookrSessionRefreshRequiredError";
  }
}

export class BookrRefreshError extends Error {
  constructor(status = null) {
    super(Number.isInteger(status)
      ? `Bookr session refresh failed with HTTP ${status}`
      : "Bookr session refresh failed before a response was received");
    this.name = "BookrRefreshError";
    this.status = Number.isInteger(status) ? status : null;
  }
}

export class BookrSubscriptionError extends Error {
  constructor(message = "Unable to determine an active Bookr subscription") {
    super(message);
    this.name = "BookrSubscriptionError";
  }
}

export class BookrBookingError extends Error {
  constructor(reason = "booking_restricted") {
    super(`Bookr.fit rejected the booking change (${reason})`);
    this.name = "BookrBookingError";
    this.reason = reason;
  }
}

export class BookrMutationVerificationError extends Error {
  constructor() {
    super("Bookr did not confirm the requested booking change");
    this.name = "BookrMutationVerificationError";
  }
}

function safeTrace(event) {
  // Keep all trace payloads metadata-only. This is intentionally exported as
  // a testable guard: callers must not leak response data, cookies, or IDs.
  const data = event?.data && typeof event.data === "object" ? event.data : undefined;
  return {
    ...event,
    data: data && Object.fromEntries(Object.entries(data).filter(([key]) =>
      !/(cookie|token|authorization|body|session|subscription|\bid\b|url|query)/i.test(key),
    )),
  };
}

function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normal = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function cookiePairs(rawCookie) {
  if (typeof rawCookie !== "string" || !rawCookie.trim()) {
    throw new BookrLoginError("BOOKR_AUTH_COOKIE is required");
  }
  const pairs = rawCookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    if (index < 1) throw new BookrLoginError("BOOKR_AUTH_COOKIE contains an invalid cookie pair");
    return [part.slice(0, index), part.slice(index + 1)];
  });
  if (pairs.length === 0) throw new BookrLoginError("BOOKR_AUTH_COOKIE is required");
  return pairs;
}

/** Parse only Bookr's logical Supabase session cookie, rejecting mixed headers. */
export function parseBookrAuthCookie(rawCookie) {
  const chunks = new Map();
  for (const [name, value] of cookiePairs(rawCookie)) {
    const match = name.match(new RegExp(`^${AUTH_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.(\\d+))?$`));
    if (!match) throw new BookrLoginError("BOOKR_AUTH_COOKIE may contain only Bookr auth-cookie chunks");
    const index = match[1] === undefined ? null : Number(match[1]);
    if (index !== null && (!Number.isInteger(index) || index < 0 || index >= MAX_COOKIE_CHUNKS)) {
      throw new BookrLoginError("BOOKR_AUTH_COOKIE has an unsupported auth-cookie chunk index");
    }
    const key = index === null ? "base" : String(index);
    if (chunks.has(key) || !value) throw new BookrLoginError("BOOKR_AUTH_COOKIE contains duplicate or empty chunks");
    if (new TextEncoder().encode(value).byteLength > COOKIE_CHUNK_SIZE) {
      throw new BookrLoginError("BOOKR_AUTH_COOKIE contains an oversized auth-cookie chunk");
    }
    chunks.set(key, value);
  }
  if (chunks.has("base")) {
    if (chunks.size !== 1) throw new BookrLoginError("BOOKR_AUTH_COOKIE cannot mix unchunked and chunked values");
    return { cookieHeader: `${AUTH_COOKIE}=${chunks.get("base")}`, encoded: chunks.get("base") };
  }
  const count = chunks.size;
  if (count === 0 || !chunks.has("0") || count > MAX_COOKIE_CHUNKS) {
    throw new BookrLoginError("BOOKR_AUTH_COOKIE has incomplete auth-cookie chunks");
  }
  const values = [];
  for (let index = 0; index < count; index += 1) {
    if (!chunks.has(String(index))) throw new BookrLoginError("BOOKR_AUTH_COOKIE has non-contiguous auth-cookie chunks");
    values.push(chunks.get(String(index)));
  }
  return {
    cookieHeader: values.map((value, index) => `${AUTH_COOKIE}.${index}=${value}`).join("; "),
    encoded: values.join(""),
  };
}

/** Decode a Supabase SSR cookie without returning its raw serialized value. */
export function decodeBookrSession(rawCookie) {
  const { encoded } = parseBookrAuthCookie(rawCookie);
  let decoded;
  try {
    const source = decodeURIComponent(encoded);
    decoded = source.startsWith("base64-") ? base64UrlDecode(source.slice(7)) : source;
  } catch {
    throw new BookrLoginError("BOOKR_AUTH_COOKIE could not be decoded");
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new BookrLoginError("BOOKR_AUTH_COOKIE does not contain a valid session");
  }
  const session = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!session || typeof session !== "object" || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") {
    throw new BookrLoginError("BOOKR_AUTH_COOKIE does not contain access and refresh tokens");
  }
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: Number(session.expires_at ?? 0),
    session,
  };
}

export function encodeBookrSession(session) {
  if (!session || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") {
    throw new BookrLoginError("Refreshed Bookr session is invalid");
  }
  const encoded = `base64-${base64UrlEncode(JSON.stringify(session))}`;
  const chunks = Array.from({ length: Math.ceil(encoded.length / COOKIE_CHUNK_SIZE) }, (_, index) =>
    encoded.slice(index * COOKIE_CHUNK_SIZE, (index + 1) * COOKIE_CHUNK_SIZE),
  );
  if (chunks.length > MAX_COOKIE_CHUNKS) throw new BookrLoginError("Refreshed Bookr session exceeds cookie limits");
  return chunks.length === 1
    ? `${AUTH_COOKIE}=${chunks[0]}`
    : chunks.map((chunk, index) => `${AUTH_COOKIE}.${index}=${chunk}`).join("; ");
}

function requireCrypto() {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable");
  return globalThis.crypto;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function authEncryptionKey(secret) {
  const crypto = requireCrypto();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function saveBookrSession(kv, bootstrapCookie, cookieHeader) {
  if (!kv?.put) return;
  const crypto = requireCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await authEncryptionKey(bootstrapCookie);
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, cookieHeader }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  await kv.put(AUTH_KV_KEY, JSON.stringify({ v: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) }));
}

export async function loadBookrSession(kv, bootstrapCookie) {
  if (!kv?.get) return null;
  const stored = await kv.get(AUTH_KV_KEY);
  if (typeof stored !== "string") return null;
  try {
    const envelope = JSON.parse(stored);
    if (envelope?.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") return null;
    const key = await authEncryptionKey(bootstrapCookie);
    const plaintext = await requireCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext),
    );
    const value = JSON.parse(new TextDecoder().decode(plaintext));
    if (value?.v !== 1 || typeof value.cookieHeader !== "string") return null;
    parseBookrAuthCookie(value.cookieHeader);
    return value.cookieHeader;
  } catch {
    // A secret rotation must not make the Worker unusable; bootstrap again.
    return null;
  }
}

function partsInZone(timestamp, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function count(value) { return Array.isArray(value) ? value.length : Number.isInteger(value) && value >= 0 ? value : null; }

/** Project Bookr's PII-rich object to the small internal class representation. */
export function normalizeBookrSession(value, { now = () => Date.now(), timezone = "Europe/Lisbon" } = {}) {
  if (!value || typeof value !== "object" || !UUID_RE.test(String(value.id ?? "")) || typeof value.title !== "string" || typeof value.startsAt !== "string") {
    throw new UnparseableError("Bookr returned an invalid class session");
  }
  const startsAt = Date.parse(value.startsAt);
  const endsAt = Date.parse(value.endsAt);
  const sessionTimezone = typeof value.timeZone === "string" && value.timeZone.trim()
    ? value.timeZone.trim()
    : timezone;
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) throw new UnparseableError("Bookr returned invalid class times");
  let start; let end;
  try { start = partsInZone(startsAt, sessionTimezone); end = partsInZone(endsAt, sessionTimezone); } catch { throw new UnparseableError("Bookr returned an invalid class timezone"); }
  const registered = count(value.registeredParticipants);
  const waitlisted = count(value.waitlistedParticipants);
  const capacity = value.capacity === null
    ? null
    : Number.isInteger(value.capacity) && value.capacity >= 0
      ? value.capacity
      : undefined;
  if (registered === null || waitlisted === null || capacity === undefined) throw new UnparseableError("Bookr returned invalid class capacity");
  const bookingStatus = value.currentUserBookingStatus;
  if (bookingStatus !== null && bookingStatus !== "booked" && bookingStatus !== "waitlisted") throw new UnparseableError("Bookr returned an invalid booking status");
  const openingAt = value.bookingWindowOpensAt ? Date.parse(value.bookingWindowOpensAt) : NaN;
  const observedAt = now();
  const waitlistLimit = value.waitlistLimit === null || value.waitlistLimit === undefined
    ? null
    : Number.isInteger(value.waitlistLimit) && value.waitlistLimit >= 0
      ? value.waitlistLimit
      : undefined;
  if (waitlistLimit === undefined) throw new UnparseableError("Bookr returned an invalid waitlist limit");
  const isFull = capacity !== null && registered >= capacity;
  return {
    id: value.id,
    name: value.title.trim(),
    details: typeof value.boxName === "string" ? value.boxName.trim() : "",
    date: start.date,
    start: start.time,
    end: end.time,
    maxCapacity: capacity,
    curCapacity: registered,
    isFull,
    isOverbooked: isFull && waitlistLimit !== null && waitlisted >= waitlistLimit,
    isOpen: Boolean(value.canBook),
    canCancel: Boolean(value.canCancel),
    enrollmentDeadlineExpired: Boolean(value.registrationDeadlineReached),
    isOver: endsAt <= observedAt,
    userIsBlocked: Boolean(value.outsideSubscriptionPeriod || value.packLimitReached || value.dailyCategoryLimitReached || value.weeklyLimitReached || value.overlappingSession || value.noShowPenaltyActive),
    userIsEnrolled: bookingStatus === "booked" || bookingStatus === "waitlisted",
    userIsWaitlisted: bookingStatus === "waitlisted",
    timeToStart: null,
    // Keep a just-elapsed opening boundary as an immediate poll when the
    // server has not flipped canBook yet; null means no usable opening signal.
    timeToEnroll: Number.isFinite(openingAt) && openingAt >= observedAt - OPENING_BOUNDARY_GRACE_MS
      ? Math.max(0, Math.ceil((openingAt - observedAt) / 1000))
      : null,
  };
}

function extractSetCookieHeaders(response) {
  const combined = response.headers.get("set-cookie");
  const values = response.headers.getSetCookie?.() ?? (
    combined ? combined.split(/,(?=\s*sb-jphimrpybgssduyuziaw-auth-token(?:\.\d+)?=)/) : []
  );
  const cookies = [];
  for (const value of values) {
    const pair = String(value).split(";", 1)[0];
    if (pair.startsWith(`${AUTH_COOKIE}=`) || new RegExp(`^${AUTH_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+=`).test(pair)) cookies.push(pair);
  }
  return cookies;
}

function mergeAuthCookies(current, response) {
  const replacements = extractSetCookieHeaders(response);
  if (replacements.length === 0) return current;
  // Supabase's SSR setAll callback emits the complete logical cookie. Start
  // from an empty set so stale chunks cannot survive a shorter replacement.
  const merged = new Map();
  for (const replacement of replacements) {
    const [name, value] = cookiePairs(replacement)[0];
    if (value) merged.set(name, value);
    else merged.delete(name);
  }
  return parseBookrAuthCookie(
    [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
  ).cookieHeader;
}

function validClassDate(value) {
  const date = String(value ?? "");
  if (!CLASS_DATE_RE.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function isMutationTransportError(error) {
  // Fetch rejects with TypeError when no authoritative HTTP response exists.
  // HTTP and response-validation failures are deterministic and must retain
  // their original, more specific diagnosis.
  return error instanceof TypeError;
}

function postResponseFailure() {
  const error = new Error("Bookr mutation response could not be durably processed");
  Object.defineProperty(error, BOOKR_POST_RESPONSE_FAILURE, { value: true });
  return error;
}

function isPostResponseFailure(error) {
  return error?.[BOOKR_POST_RESPONSE_FAILURE] === true;
}

/** Return whether a request is one of the fixed Bookr API method/path pairs. */
export function isAllowedBookrRequest(url, method) {
  const resolvedMethod = String(method ?? "").toUpperCase();
  if (
    !(url instanceof URL) ||
    url.origin !== BOOKR_ORIGIN ||
    url.username ||
    url.password ||
    url.hash
  ) return false;
  if (url.pathname === "/dashboard") {
    return resolvedMethod === "GET" && !url.search;
  }
  if (url.pathname === "/api/dashboard/athlete-calendar/day") {
    const dateValues = url.searchParams.getAll("date");
    return resolvedMethod === "GET" &&
      url.searchParams.size === 1 &&
      dateValues.length === 1 &&
      validClassDate(dateValues[0]);
  }
  return url.pathname === "/api/dashboard/athlete-class-bookings" &&
    !url.search &&
    (resolvedMethod === "POST" || resolvedMethod === "DELETE");
}

async function responseText(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new UnparseableError("Bookr response exceeded size limit");
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Keep compatibility with minimal response doubles and empty responses.
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new UnparseableError("Bookr response exceeded size limit");
    return text;
  }
  const decoder = new TextDecoder();
  const parts = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* cancellation is best effort */ }
        throw new UnparseableError("Bookr response exceeded size limit");
      }
      parts.push(decoder.decode(chunk, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock?.();
  }
}

function rejectRedirectResponse(response, error) {
  const status = Number(response?.status);
  const hasRedirectStatus = Number.isInteger(status) && status >= 300 && status <= 399;
  const hasLocation = Boolean(response?.headers?.get?.("location"));
  if (hasRedirectStatus || hasLocation) throw error;
}

async function responseJson(response) {
  const contentType = response.headers.get("content-type");
  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new UnparseableError("Bookr returned an unexpected response type");
  }
  const text = await responseText(response);
  try { return JSON.parse(text); } catch { throw new UnparseableError("Bookr returned invalid JSON"); }
}

async function responseDocument(response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/x-component")) {
    throw new UnparseableError("Bookr returned an unexpected dashboard response type");
  }
  return responseText(response);
}

async function bookrResponseError(response) {
  let reason = null;
  try {
    const payload = await responseJson(response);
    const candidates = [payload?.error, payload?.code, payload?.message];
    reason = candidates.find((value) => BOOKING_ERROR_CODES.has(value)) ?? null;
  } catch {
    // Error bodies are untrusted and optional. The status remains sufficient.
  }
  if (reason === "waitlist_full") return new ClassIsOverbookedError();
  if (reason === "subscription_not_valid_for_session") return new BookrSubscriptionError();
  if (reason) return new BookrBookingError(reason);
  return new Error(`Bookr request failed with HTTP ${response.status}`);
}

/** Extract only the active subscription UUID from a Next Flight response. */
export function extractInitialSubscriptionId(document) {
  const values = new Set();
  const normalized = String(document).replace(/\\+(?=["'])/g, "");
  const re = /initialSubscription["']?\s*[:=]\s*\{([\s\S]{0,8192}?)\}/g;
  for (const match of normalized.matchAll(re)) {
    const id = match[1].match(/["']id["']\s*:\s*["']([0-9a-f-]{36})["']/i)?.[1];
    if (id && UUID_RE.test(id)) values.add(id);
  }
  if (values.size !== 1) throw new BookrSubscriptionError();
  return [...values][0];
}

function bookrResult(operation, status, classType, extra = {}) { return { operation, status, classType, ...extra }; }

function openingNoop(classType, session, now) {
  return bookrResult("enroll", "noop", classType, {
    cacheState: "not_open",
    enrollmentOpensAt: session.timeToEnroll === null ? null : new Date(now() + session.timeToEnroll * 1000).toISOString(),
    lastCheckedAt: new Date(now()).toISOString(),
  });
}

export function createBookrClient({
  authCookie,
  kv,
  fetchImpl = fetch,
  timezone = "Europe/Lisbon",
  now = () => Date.now(),
  onTrace = async () => {},
  supabasePublishableKey = SUPABASE_PUBLISHABLE_KEY,
  persistSession = true,
  refreshSleep = defaultSleep,
  refreshBackoffMs = defaultRefreshBackoffMs,
} = {}) {
  if (!authCookie) throw new BookrLoginError("BOOKR_AUTH_COOKIE is required");
  const bootstrapCookie = parseBookrAuthCookie(authCookie).cookieHeader;
  let cookieHeader = bootstrapCookie;
  let subscriptionId = null;
  const trace = async (event) => { try { await onTrace(safeTrace(event)); } catch { /* tracing is best effort */ } };

  async function persistCookieHeader() {
    if (persistSession) await saveBookrSession(kv, bootstrapCookie, cookieHeader);
  }

  async function request(path, { method = "GET", body, mutation = false } = {}) {
    const resolvedMethod = String(method).toUpperCase();
    const url = new URL(path, BOOKR_ORIGIN);
    if (!isAllowedBookrRequest(url, resolvedMethod)) throw new Error("Bookr request used a disallowed endpoint");
    const response = await fetchImpl(url.href, {
      method: resolvedMethod,
      // Do not follow a first-party redirect with a manually supplied Cookie
      // header: the endpoint allowlist must remain true for the complete hop.
      // Cloudflare Workers rejects redirect:"error" before issuing the fetch;
      // manual lets us inspect and reject the response ourselves.
      redirect: "manual",
      cache: "no-store",
      headers: {
        Accept: resolvedMethod === "GET" ? "application/json, text/html;q=0.9" : "application/json",
        Cookie: cookieHeader,
        "Cache-Control": "no-store",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Reject before inspecting Set-Cookie or the body. A redirect is never
    // allowed to establish state, even when it happens to include a location
    // on the same origin.
    rejectRedirectResponse(response, new UnparseableError("Bookr returned an unexpected redirect"));
    // An authentication rejection must not replace the last known-good cookie,
    // even if a stale or malicious Set-Cookie header accompanies the response.
    if (response.status !== 401 && response.status !== 403) {
      try {
        const mergedCookieHeader = mergeAuthCookies(cookieHeader, response);
        const didRotateCookie = mergedCookieHeader !== cookieHeader;
        cookieHeader = mergedCookieHeader;
        // Every accepted first-party rotation is durable before an isolate can
        // be reclaimed. A failed write after a successful mutation response
        // leaves the mutation outcome ambiguous.
        if (didRotateCookie) await persistCookieHeader();
      } catch (error) {
        if (mutation && response.ok) throw postResponseFailure();
        throw error;
      }
    }
    await trace({ level: response.ok ? "info" : "warn", scope: "http", code: "bookr_response_received", message: `Bookr request returned HTTP ${response.status}`, data: { endpointPath: url.pathname, httpStatus: response.status } });
    if (response.status === 401 || response.status === 403) throw new BookrLoginError();
    if (!response.ok) throw await bookrResponseError(response);
    return response;
  }

  async function refreshIfNeeded() {
    const decoded = decodeBookrSession(cookieHeader);
    if (!decoded.expiresAt || decoded.expiresAt * 1000 > now() + 60_000) return;
    // A status-page health check is deliberately non-mutating. Supabase refresh
    // tokens rotate when used, so refreshing without persisting the replacement
    // would invalidate the Worker's durable session.
    if (!persistSession) throw new BookrSessionRefreshRequiredError();
    if (!supabasePublishableKey) throw new BookrLoginError("Bookr session needs refresh but the public auth configuration is unavailable");
    let lastStatus = null;
    for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`${SUPABASE_ORIGIN}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          // The refresh body contains the rotation credential; never follow a
          // redirect to a different origin and never cache either request or body.
          // See the first-party request above for why this is manual.
          redirect: "manual",
          cache: "no-store",
          headers: {
            apikey: supabasePublishableKey,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
          body: JSON.stringify({ refresh_token: decoded.refreshToken }),
        });
      } catch {
        if (attempt === MAX_REFRESH_ATTEMPTS) throw new BookrRefreshError();
        const delayMs = Number(refreshBackoffMs(attempt));
        if (Number.isFinite(delayMs) && delayMs > 0) await refreshSleep(delayMs);
        continue;
      }
      // Do not treat a redirect as a refresh response: it must not be retried,
      // parsed, or allowed to replace the durable auth cookie.
      rejectRedirectResponse(response, new BookrRefreshError(response.status));
      lastStatus = Number.isInteger(response.status) ? response.status : null;
      if (response.ok) {
        const refreshed = await responseJson(response);
        const refreshedCookie = encodeBookrSession(refreshed);
        // Only replace and persist the durable cookie after the response has
        // passed JSON and session-shape validation.
        cookieHeader = refreshedCookie;
        await persistCookieHeader();
        return;
      }
      if ([400, 401, 403].includes(response.status)) throw new BookrLoginError(undefined, response.status);
      const transient = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (!transient || attempt === MAX_REFRESH_ATTEMPTS) throw new BookrRefreshError(lastStatus);
      const delayMs = Number(refreshBackoffMs(attempt));
      if (Number.isFinite(delayMs) && delayMs > 0) await refreshSleep(delayMs);
    }
    throw new BookrRefreshError(lastStatus);
  }

  async function listClasses(classDate) {
    if (!validClassDate(classDate)) throw new UnparseableError("Bookr class date must use YYYY-MM-DD");
    await refreshIfNeeded();
    const response = await request(`/api/dashboard/athlete-calendar/day?date=${encodeURIComponent(classDate)}`);
    const payload = await responseJson(response);
    if (!payload || !Array.isArray(payload.selectedDaySessions)) throw new UnparseableError("Bookr returned an invalid class calendar");
    return payload.selectedDaySessions.map((session) => normalizeBookrSession(session, { now, timezone }));
  }

  async function bootstrapSession() {
    // A status probe may safely read the worker's current encrypted session, but
    // persistSession controls all writes and refresh persistence.
    const cached = await loadBookrSession(kv, bootstrapCookie);
    if (cached) cookieHeader = cached;
    await refreshIfNeeded();
    const response = await request("/dashboard");
    const document = await responseDocument(response);
    try {
      subscriptionId = extractInitialSubscriptionId(document);
    } catch (error) {
      // Authentication is established by the successful dashboard response.
      // Subscription data is only required for enrollment, while unenrollment
      // needs only the session id and can proceed without it.
      if (!(error instanceof BookrSubscriptionError)) throw error;
      subscriptionId = null;
    }
    await persistCookieHeader();
    return { authenticated: true, subscriptionId };
  }

  async function verify(sessionId, expected) {
    const session = (await listClasses(expected.date)).find((candidate) => candidate.id === sessionId);
    if (!session) throw new UnparseableError("Bookr did not return the changed class");
    const actual = expected.operation === "enroll" ? session.userIsEnrolled : !session.userIsEnrolled;
    if (!actual) throw new BookrMutationVerificationError();
    return session;
  }

  async function mutate(operation, selected) {
    if (!UUID_RE.test(selected?.id ?? "")) throw new UnparseableError("Bookr class identifier is invalid");
    if (operation === "enroll" && !subscriptionId) throw new BookrSubscriptionError();
    let response;
    try {
      response = await request("/api/dashboard/athlete-class-bookings", {
        method: operation === "enroll" ? "POST" : "DELETE",
        mutation: true,
        body: operation === "enroll" ? { sessionId: selected.id, subscriptionId } : { sessionId: selected.id },
      });
      // Validate success JSON, but authoritative success is the read-back below.
      await responseJson(response);
    } catch (error) {
      // A lost transport has no authoritative response, and a successful HTTP
      // status with an unreadable body may still mean Bookr applied the change.
      // Both outcomes are ambiguous; deterministic 4xx/auth/restriction errors
      // remain authoritative and retain their original diagnosis.
      const postResponseError = isPostResponseFailure(error);
      const ambiguousMutation = isMutationTransportError(error) || postResponseError ||
        (response?.ok === true && error instanceof UnparseableError);
      // Network ambiguity is safe only when the read-back proves the result.
      try {
        const verified = await verify(selected.id, { operation, date: selected.date });
        // A rotated in-memory cookie is not enough when its durable KV write
        // failed: the next invocation could send the stale refresh token.
        if (postResponseError) throw new BookrMutationVerificationError();
        return verified;
      } catch (verificationError) {
        // A completed read-back showing the old state is stronger evidence
        // than the transport error: report the mutation as unverified.
        if (ambiguousMutation) throw new BookrMutationVerificationError();
        throw error;
      }
    }
    try {
      return await verify(selected.id, { operation, date: selected.date });
    } catch (verificationError) {
      // Once Bookr has accepted the mutation, a failed read-back cannot prove
      // whether it completed. Keep the result stable and prevent callers from
      // replaying a potentially completed booking change.
      if (verificationError instanceof BookrMutationVerificationError) throw verificationError;
      throw new BookrMutationVerificationError();
    }
  }

  return { timezone, bootstrapSession, listClasses, enroll: (session) => mutate("enroll", session), unenroll: (session) => mutate("unenroll", session) };
}

/**
 * Bookr returns the class title and box separately, while legacy calendar
 * rules commonly include both (for example, "WOD Rato"). Match that legacy
 * spelling only when the suffix is the complete, exact box name.
 */
function matchesBookrClassType(session, requestedType) {
  const requested = String(requestedType ?? "").trim().toUpperCase();
  const name = String(session.name ?? "").trim().toUpperCase();
  if (requested === name) return true;
  const box = String(session.details ?? "").trim().toUpperCase();
  if (!box || !requested.endsWith(` ${box}`)) return false;
  return requested.slice(0, -(box.length + 1)).trim() === name;
}

function selectSession(sessions, { classDate, classTime, classTypes, operation = "enroll" }) {
  const matchesByType = classTypes.map((classType) => sessions.filter((session) =>
      session.date === classDate &&
      session.start === classTime &&
      matchesBookrClassType(session, classType),
    ));
  if (operation === "unenroll") {
    const enrolled = new Map();
    for (const matches of matchesByType) {
      for (const session of matches) {
        if (session.userIsEnrolled) enrolled.set(session.id, session);
      }
    }
    if (enrolled.size > 1) throw new UnparseableError("Bookr returned ambiguous matching classes");
    if (enrolled.size === 1) return enrolled.values().next().value;
  }
  for (const matches of matchesByType) {
    // Fallbacks are ordered: a later ambiguous fallback must not mask an
    // earlier unique candidate that already satisfies the request.
    if (matches.length > 1) throw new UnparseableError("Bookr returned ambiguous matching classes");
    if (matches.length === 1) return matches[0];
  }
  throw new ClassNotFoundError({ classType: classTypes[0], classTime, classDate });
}

/** Bookr equivalent of Regybox runOperation: same result envelope and no-op semantics. */
export async function runBookrOperation({ client, operation = "enroll", classDate, classTime, classType, timeoutSeconds = 900, notOpenIsNoop = false, now = () => Date.now(), sleep = defaultSleep, maxPolls = 40, onTrace = async () => {} } = {}) {
  if (!client || !classDate || !classTime) throw new Error("client, classDate, and classTime are required");
  if (operation !== "enroll" && operation !== "unenroll") throw new Error(`Unsupported operation: ${operation}`);
  const classTypes = parseClassTypes(classType);
  if (classTypes.length === 0) throw new Error("classType must include at least one class name");
  const normalizedTime = String(classTime).padStart(5, "0");
  const trace = async (event) => { try { await onTrace(safeTrace(event)); } catch { /* best effort */ } };
  const startedAt = now();
  for (let poll = 0; poll < maxPolls && now() - startedAt < timeoutSeconds * 1000; poll += 1) {
    const selected = selectSession(await client.listClasses(classDate), { classDate, classTime: normalizedTime, classTypes, operation });
    await trace({ level: "info", scope: "bookr", code: "class_state_observed", message: "Parsed Bookr class state", data: { fetchCount: poll + 1, isOpen: selected.isOpen, userIsEnrolled: selected.userIsEnrolled, isFull: selected.isFull } });
    if (operation === "unenroll") {
      if (!selected.userIsEnrolled) return bookrResult("unenroll", "noop", selected.name);
      if (!selected.canCancel) throw new BookrBookingError("cancellation_window_closed");
      await client.unenroll(selected);
      return bookrResult("unenroll", "success", selected.name);
    }
    if (selected.userIsEnrolled) return bookrResult("enroll", "noop", selected.name);
    if (selected.isOverbooked) throw new ClassIsOverbookedError();
    if (selected.enrollmentDeadlineExpired) throw new BookrBookingError("registration_deadline_passed");
    if (selected.isOpen && !selected.userIsBlocked) {
      await client.enroll(selected);
      return bookrResult("enroll", "success", selected.name);
    }
    if (selected.userIsBlocked) throw new BookrBookingError("booking_restricted");
    const remaining = Math.max(0, timeoutSeconds - Math.ceil((now() - startedAt) / 1000));
    if (selected.enrollmentDeadlineExpired || selected.userIsBlocked || selected.timeToEnroll === null || selected.timeToEnroll > remaining) {
      if (notOpenIsNoop) return openingNoop(selected.name, selected, now);
      if (selected.timeToEnroll !== null && selected.timeToEnroll > remaining) throw new RegyboxTimeoutError(timeoutSeconds, { timeToEnroll: selected.timeToEnroll });
      throw new ClassNotOpenError();
    }
    const wait = selected.timeToEnroll > 60 ? 60 : selected.timeToEnroll > 10 ? 10 : 1;
    await trace({ level: "info", scope: "bookr", code: "enrollment_wait", message: "Bookr enrollment is not open yet", data: { timerSeconds: selected.timeToEnroll, waitSeconds: wait } });
    await sleep(wait * 1000);
  }
  throw new RegyboxTimeoutError(timeoutSeconds);
}

export const BOOKR_AUTH_COOKIE_NAME = AUTH_COOKIE;
