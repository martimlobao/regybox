import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  BOOKR_AUTH_COOKIE_NAME,
  BookrBookingError,
  BookrLoginError,
  BookrSessionRefreshRequiredError,
  BookrSubscriptionError,
  createBookrClient,
  decodeBookrSession,
  encodeBookrSession,
  extractInitialSubscriptionId,
  isAllowedBookrRequest,
  loadBookrSession,
  normalizeBookrSession,
  parseBookrAuthCookie,
  runBookrOperation,
  saveBookrSession,
} from "../src/bookr.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const sessionId = "11111111-1111-4111-8111-111111111111";
const subscriptionId = "22222222-2222-4222-8222-222222222222";

function authCookie(expiresAt = 2_000_000_000) {
  return encodeBookrSession({ access_token: "access-token", refresh_token: "refresh-token", expires_at: expiresAt });
}

function apiSession(overrides = {}) {
  return {
    id: sessionId,
    title: "WOD Rato",
    boxName: "Rato",
    startsAt: "2026-09-05T06:30:00.000Z",
    endsAt: "2026-09-05T07:20:00.000Z",
    timeZone: "Europe/Lisbon",
    capacity: 14,
    registeredParticipants: [],
    waitlistedParticipants: [],
    waitlistLimit: 4,
    currentUserBookingStatus: null,
    canBook: true,
    canCancel: false,
    registrationDeadlineReached: false,
    ...overrides,
  };
}

function memoryKv() {
  const values = new Map();
  return { values, get: async (key) => values.get(key) ?? null, put: async (key, value) => values.set(key, value) };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function dashboardResponse(body = `initialSubscription:{"id":"${subscriptionId}"}`, init = {}) {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
}

test("Bookr cookie parsing accepts a complete logical cookie and rejects unsafe mixtures", () => {
  const cookie = authCookie();
  assert.equal(parseBookrAuthCookie(cookie).cookieHeader, cookie);
  const decoded = decodeBookrSession(cookie);
  assert.equal(decoded.accessToken, "access-token");
  assert.equal(decoded.refreshToken, "refresh-token");
  assert.throws(() => parseBookrAuthCookie(`${cookie}; PHPSESSID=not-bookr`), BookrLoginError);
  assert.throws(() => parseBookrAuthCookie(`${BOOKR_AUTH_COOKIE_NAME}.0=a; ${BOOKR_AUTH_COOKIE_NAME}.2=b`), BookrLoginError);
  assert.throws(() => parseBookrAuthCookie(`${BOOKR_AUTH_COOKIE_NAME}=a; ${BOOKR_AUTH_COOKIE_NAME}.0=b`), BookrLoginError);

  const chunked = encodeBookrSession({
    access_token: "a".repeat(4_000),
    refresh_token: "refresh-token",
    expires_at: 2_000_000_000,
  });
  const reversed = chunked.split("; ").reverse().join("; ");
  assert.equal(parseBookrAuthCookie(reversed).cookieHeader, chunked);
  assert.equal(decodeBookrSession(reversed).refreshToken, "refresh-token");
  assert.throws(
    () => parseBookrAuthCookie(`${BOOKR_AUTH_COOKIE_NAME}.0=a; ${BOOKR_AUTH_COOKIE_NAME}.16=b`),
    BookrLoginError,
  );
  assert.throws(
    () => parseBookrAuthCookie(`${BOOKR_AUTH_COOKIE_NAME}=${"a".repeat(3181)}`),
    /oversized auth-cookie chunk/,
  );
});

test("Bookr allowlists exact first-party method and path pairs", () => {
  assert.equal(isAllowedBookrRequest(new URL("https://bookr.fit/dashboard"), "GET"), true);
  assert.equal(
    isAllowedBookrRequest(new URL("https://bookr.fit/api/dashboard/athlete-calendar/day?date=2026-09-05"), "GET"),
    true,
  );
  assert.equal(
    isAllowedBookrRequest(new URL("https://bookr.fit/api/dashboard/athlete-class-bookings"), "POST"),
    true,
  );
  assert.equal(
    isAllowedBookrRequest(new URL("https://bookr.fit/api/dashboard/athlete-class-bookings"), "DELETE"),
    true,
  );
  assert.equal(isAllowedBookrRequest(new URL("https://bookr.fit/dashboard"), "POST"), false);
  assert.equal(
    isAllowedBookrRequest(new URL("https://bookr.fit/api/dashboard/athlete-calendar/day?date=2026-09-05"), "DELETE"),
    false,
  );
  assert.equal(
    isAllowedBookrRequest(new URL("https://bookr.fit/api/dashboard/athlete-calendar/day?date=2026-09-05&extra=1"), "GET"),
    false,
  );
  assert.equal(
    isAllowedBookrRequest(new URL("https://bookr.fit/api/dashboard/athlete-calendar/day?date=2026-09-05&date=2026-09-05"), "GET"),
    false,
  );
  assert.equal(
    isAllowedBookrRequest(new URL("https://bookr.fit/api/dashboard/athlete-calendar/day?date=2026-02-30"), "GET"),
    false,
  );
  assert.equal(isAllowedBookrRequest(new URL("https://example.test/dashboard"), "GET"), false);
  assert.equal(isAllowedBookrRequest(new URL("https://user:secret@bookr.fit/dashboard"), "GET"), false);
  assert.equal(isAllowedBookrRequest(new URL("https://bookr.fit/dashboard#fragment"), "GET"), false);
});

test("Bookr auth session is encrypted in KV and fails safely after secret rotation", async () => {
  const kv = memoryKv();
  const bootstrap = authCookie();
  const refreshed = authCookie(2_100_000_000);
  await saveBookrSession(kv, bootstrap, refreshed);
  assert.ok(kv.values.values().next().value.includes("ciphertext"));
  assert.ok(!kv.values.values().next().value.includes("access-token"));
  assert.equal(await loadBookrSession(kv, bootstrap), refreshed);
  assert.equal(await loadBookrSession(kv, `${BOOKR_AUTH_COOKIE_NAME}=different`), null);
});

test("Bookr subscription extraction is narrow and rejects missing or ambiguous dashboard data", () => {
  assert.equal(extractInitialSubscriptionId(`self.__next_f.push([1,'initialSubscription:{"id":"${subscriptionId}"}'])`), subscriptionId);
  assert.equal(
    extractInitialSubscriptionId(
      `self.__next_f.push([1,"{\\\"initialSubscription\\\":{\\\"id\\\":\\\"${subscriptionId}\\\"}}"]);`,
    ),
    subscriptionId,
  );
  assert.throws(() => extractInitialSubscriptionId("initialSubscription:null"), BookrSubscriptionError);
  assert.throws(() => extractInitialSubscriptionId(`initialSubscription:{"id":"${subscriptionId}"};initialSubscription:{"id":"33333333-3333-4333-8333-333333333333"}`), BookrSubscriptionError);
});

test("Bookr class normalization discards participant data and retains booking state", () => {
  const parsed = normalizeBookrSession(apiSession({
    registeredParticipants: [{ id: "a", name: "private" }], waitlistedParticipants: [{ id: "b", note: "private" }], currentUserBookingStatus: "waitlisted",
  }));
  assert.deepEqual(Object.keys(parsed).sort(), [
    "canCancel", "curCapacity", "date", "details", "end", "enrollmentDeadlineExpired", "id", "isFull", "isOpen", "isOver", "isOverbooked", "maxCapacity", "name", "start", "timeToEnroll", "timeToStart", "userIsBlocked", "userIsEnrolled", "userIsWaitlisted",
  ].sort());
  assert.equal(parsed.curCapacity, 1);
  assert.equal(parsed.userIsWaitlisted, true);
  assert.doesNotMatch(JSON.stringify(parsed), /private/);

  const unlimited = normalizeBookrSession(apiSession({
    capacity: null,
    waitlistLimit: null,
  }));
  assert.equal(unlimited.maxCapacity, null);
  assert.equal(unlimited.isFull, false);
  assert.equal(unlimited.isOverbooked, false);
});

test("Bookr client uses only expected endpoints, bootstraps subscription, and verifies booking mutation", async () => {
  const calls = [];
  let current = apiSession();
  const client = createBookrClient({
    authCookie: authCookie(), timezone: "Europe/Lisbon", kv: memoryKv(),
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      if (url === "https://bookr.fit/dashboard") return dashboardResponse();
      if (url.includes("athlete-calendar/day")) return jsonResponse({ selectedDaySessions: [current] });
      if (options.method === "POST") { current = apiSession({ currentUserBookingStatus: "booked", canBook: false, canCancel: true }); return jsonResponse({ status: "booked" }); }
      throw new Error(`unexpected ${url}`);
    },
  });
  await client.bootstrapSession();
  const selected = (await client.listClasses("2026-09-05"))[0];
  await client.enroll(selected);
  assert.deepEqual(calls.map(({ url }) => url.pathname), ["/dashboard", "/api/dashboard/athlete-calendar/day", "/api/dashboard/athlete-class-bookings", "/api/dashboard/athlete-calendar/day"]);
  assert.deepEqual(JSON.parse(calls[2].options.body), { sessionId, subscriptionId });
  for (const { options } of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers["Cache-Control"], "no-store");
  }
  assert.doesNotMatch(JSON.stringify(calls), /access-token|refresh-token/);
});

test("Bookr rejects redirects before an authenticated request can leave its allowlist", async () => {
  const calls = [];
  const client = createBookrClient({
    authCookie: authCookie(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, {
        status: 302,
        headers: { location: "https://outside.example.test/collect" },
      });
    },
  });

  await assert.rejects(() => client.bootstrapSession(), /HTTP 302/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.headers["Cache-Control"], "no-store");
});

test("Bookr run operation preserves success, no-op, and not-open envelopes", async () => {
  const booked = normalizeBookrSession(apiSession({ currentUserBookingStatus: "booked", canBook: false }));
  const client = { timezone: "Europe/Lisbon", bootstrapSession: async () => {}, listClasses: async () => [booked] };
  assert.deepEqual(await runBookrOperation({ client, classDate: "2026-09-05", classTime: "07:30", classType: "WOD Rato" }), { operation: "enroll", status: "noop", classType: "WOD Rato" });

  const late = normalizeBookrSession(apiSession({ canBook: false, bookingWindowOpensAt: "2030-01-01T00:00:00.000Z" }));
  const result = await runBookrOperation({ client: { ...client, listClasses: async () => [late] }, classDate: "2026-09-05", classTime: "07:30", classType: "WOD Rato", notOpenIsNoop: true, now: () => Date.parse("2026-09-01T00:00:00.000Z") });
  assert.equal(result.cacheState, "not_open");
  assert.equal(result.status, "noop");

  const missingOpening = normalizeBookrSession(apiSession({ canBook: false }));
  const noOpenResult = await runBookrOperation({
    client: { ...client, listClasses: async () => [missingOpening] },
    classDate: "2026-09-05",
    classTime: "07:30",
    classType: "WOD Rato",
    notOpenIsNoop: true,
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
  });
  assert.deepEqual(noOpenResult, {
    operation: "enroll",
    status: "noop",
    classType: "WOD Rato",
    cacheState: "not_open",
    enrollmentOpensAt: null,
    lastCheckedAt: "2026-09-01T00:00:00.000Z",
  });

  const absent = normalizeBookrSession(apiSession());
  assert.deepEqual(
    await runBookrOperation({
      client: { ...client, listClasses: async () => [absent] },
      operation: "unenroll",
      classDate: "2026-09-05",
      classTime: "07:30",
      classType: "WOD Rato",
    }),
    { operation: "unenroll", status: "noop", classType: "WOD Rato" },
  );
});

test("Bookr fails closed on ambiguous class matches across boxes", async () => {
  const sessions = [
    normalizeBookrSession(apiSession()),
    normalizeBookrSession(apiSession({
      id: "33333333-3333-4333-8333-333333333333",
      boxName: "Saldanha",
    })),
  ];
  await assert.rejects(
    () => runBookrOperation({
      client: { listClasses: async () => sessions },
      classDate: "2026-09-05",
      classTime: "07:30",
      classType: "WOD Rato",
    }),
    /ambiguous matching classes/,
  );
});

test("Bookr matching accepts legacy class rules with an exact box suffix", async () => {
  for (const title of ["WOD", "Open Box"]) {
    const session = normalizeBookrSession(apiSession({ title, boxName: "Rato" }));
    const client = { listClasses: async () => [session], enroll: async () => {} };
    const result = await runBookrOperation({
      client,
      classDate: "2026-09-05",
      classTime: "07:30",
      classType: `${title} Rato`,
    });
    assert.deepEqual(result, { operation: "enroll", status: "success", classType: title });
  }
});

test("Bookr matching does not strip a partial or unrelated box suffix", async () => {
  const session = normalizeBookrSession(apiSession({ title: "WOD", boxName: "Rato" }));
  const client = { listClasses: async () => [session] };
  await assert.rejects(
    () => runBookrOperation({ client, classDate: "2026-09-05", classTime: "07:30", classType: "WOD Raton" }),
    /Unable to find class/,
  );
  await assert.rejects(
    () => runBookrOperation({ client, classDate: "2026-09-05", classTime: "07:30", classType: "WOD Lisbon" }),
    /Unable to find class/,
  );
});

test("Bookr matching fails closed when an exact box suffix matches multiple sessions", async () => {
  const first = normalizeBookrSession(apiSession({ id: sessionId, title: "WOD", boxName: "Rato" }));
  const second = normalizeBookrSession(apiSession({ id: "33333333-3333-4333-8333-333333333333", title: "WOD", boxName: "Rato" }));
  const client = { listClasses: async () => [first, second] };
  await assert.rejects(
    () => runBookrOperation({ client, classDate: "2026-09-05", classTime: "07:30", classType: "WOD Rato" }),
    /ambiguous matching classes/,
  );
});

test("Bookr unenrollment searches fallback class names for an enrolled candidate", async () => {
  const primary = normalizeBookrSession(apiSession({ title: "WOD", boxName: "Rato" }));
  const fallback = normalizeBookrSession(apiSession({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Weekend WOD",
    boxName: "Rato",
    currentUserBookingStatus: "booked",
    canCancel: true,
  }));
  const unenrolled = [];
  const client = {
    listClasses: async () => [primary, fallback],
    unenroll: async (session) => unenrolled.push(session.id),
    enroll: async (session) => unenrolled.push(`enroll:${session.id}`),
  };

  const result = await runBookrOperation({
    client,
    operation: "unenroll",
    classDate: "2026-09-05",
    classTime: "07:30",
    classType: "WOD Rato, Weekend WOD Rato",
  });
  assert.deepEqual(result, { operation: "unenroll", status: "success", classType: "Weekend WOD" });
  assert.deepEqual(unenrolled, [fallback.id]);

  const enrollCalls = [];
  const enrollResult = await runBookrOperation({
    client: {
      ...client,
      enroll: async (session) => enrollCalls.push(session.id),
    },
    operation: "enroll",
    classDate: "2026-09-05",
    classTime: "07:30",
    classType: "WOD Rato, Weekend WOD Rato",
  });
  assert.deepEqual(enrollResult, { operation: "enroll", status: "success", classType: "WOD" });
  assert.deepEqual(enrollCalls, [primary.id]);
});

test("Bookr listClasses uses the configured timezone when a session omits timeZone", async () => {
  const session = apiSession({ timeZone: undefined });
  const client = createBookrClient({
    authCookie: authCookie(),
    timezone: "America/New_York",
    fetchImpl: async (url) => url.endsWith("/dashboard")
      ? dashboardResponse()
      : jsonResponse({ selectedDaySessions: [session] }),
  });
  await client.bootstrapSession();
  const [parsed] = await client.listClasses("2026-09-05");
  assert.equal(parsed.date, "2026-09-05");
  assert.equal(parsed.start, "02:30");
});

test("Bookr session timeZone overrides the configured fallback timezone", () => {
  const parsed = normalizeBookrSession(apiSession({ timeZone: "Europe/Lisbon" }), { timezone: "America/New_York" });
  assert.equal(parsed.start, "07:30");
});

test("Bookr verifies an ambiguous booking result without replaying the mutation", async () => {
  let state = apiSession();
  let mutationCount = 0;
  const client = createBookrClient({
    authCookie: authCookie(),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/dashboard")) {
        return dashboardResponse();
      }
      if (url.includes("athlete-calendar/day")) {
        return jsonResponse({ selectedDaySessions: [state] });
      }
      if (options.method === "POST") {
        mutationCount += 1;
        state = apiSession({ currentUserBookingStatus: "booked", canBook: false, canCancel: true });
        throw new TypeError("connection closed after the server accepted the booking");
      }
      throw new Error("unexpected request");
    },
  });
  await client.bootstrapSession();
  const selected = (await client.listClasses("2026-09-05"))[0];
  const verified = await client.enroll(selected);
  assert.equal(verified.userIsEnrolled, true);
  assert.equal(mutationCount, 1);
});

test("Bookr client refreshes expiring sessions without exposing tokens to traces", async () => {
  const traces = [];
  const refreshOptions = [];
  const client = createBookrClient({
    authCookie: authCookie(1), timezone: "Europe/Lisbon", kv: memoryKv(), now: () => 10_000,
    supabasePublishableKey: "public-key", onTrace: async (event) => traces.push(event),
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://jphimrpybgssduyuziaw.supabase.co/")) {
        refreshOptions.push(options);
        return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_at: 2_000_000_000 });
      }
      if (url === "https://bookr.fit/dashboard") return dashboardResponse();
      throw new Error("unexpected request");
    },
  });
  await client.bootstrapSession();
  assert.equal(refreshOptions.length, 1);
  assert.equal(refreshOptions[0].redirect, "error");
  assert.equal(refreshOptions[0].cache, "no-store");
  assert.equal(refreshOptions[0].headers["Cache-Control"], "no-store");
  assert.doesNotMatch(JSON.stringify(traces), /new-access|new-refresh|access-token|refresh-token/);
});

test("Bookr persists a complete refreshed auth cookie returned by the dashboard", async () => {
  const kv = memoryKv();
  const bootstrap = authCookie();
  const refreshed = authCookie(2_100_000_000);
  const client = createBookrClient({
    authCookie: bootstrap,
    kv,
    fetchImpl: async (url) => {
      assert.equal(url, "https://bookr.fit/dashboard");
      return dashboardResponse(undefined, {
        headers: { "set-cookie": `${refreshed}; Path=/; Secure; SameSite=Lax` },
      });
    },
  });

  await client.bootstrapSession();
  assert.equal(await loadBookrSession(kv, bootstrap), refreshed);
});

test("Bookr persists an accepted auth-cookie rotation from a calendar response", async () => {
  const kv = memoryKv();
  const bootstrap = authCookie();
  const rotated = encodeBookrSession({
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
    expires_at: 2_100_000_000,
  });
  const client = createBookrClient({
    authCookie: bootstrap,
    kv,
    fetchImpl: async (url) => {
      if (url.endsWith("/dashboard")) return dashboardResponse();
      if (url.includes("athlete-calendar/day")) {
        return jsonResponse({ selectedDaySessions: [apiSession()] }, {
          headers: { "set-cookie": `${rotated}; Path=/; Secure; SameSite=Lax` },
        });
      }
      throw new Error("unexpected request");
    },
  });

  await client.bootstrapSession();
  await client.listClasses("2026-09-05");
  assert.equal(await loadBookrSession(kv, bootstrap), rotated);
});

test("Bookr keeps the last known-good cookie after a rejected response", async () => {
  const bootstrap = authCookie();
  const rotated = encodeBookrSession({
    access_token: "rejected-access",
    refresh_token: "rejected-refresh",
    expires_at: 2_100_000_000,
  });
  const seenCookies = [];
  let calendarRequests = 0;
  const client = createBookrClient({
    authCookie: bootstrap,
    fetchImpl: async (url, options) => {
      seenCookies.push(options.headers.Cookie);
      if (url.endsWith("/dashboard")) return dashboardResponse();
      calendarRequests += 1;
      if (calendarRequests === 1) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "set-cookie": `${rotated}; Path=/; Secure; SameSite=Lax` },
        });
      }
      return jsonResponse({ selectedDaySessions: [apiSession()] });
    },
  });

  await client.bootstrapSession();
  await assert.rejects(() => client.listClasses("2026-09-05"), BookrLoginError);
  await client.listClasses("2026-09-05");
  assert.deepEqual(seenCookies, [bootstrap, bootstrap, bootstrap]);
});

test("Bookr status-style client never rotates an expiring session or writes KV", async () => {
  const kv = memoryKv();
  let requestCount = 0;
  const client = createBookrClient({
    authCookie: authCookie(1),
    kv,
    now: () => 10_000,
    persistSession: false,
    fetchImpl: async () => {
      requestCount += 1;
      throw new Error("unexpected request");
    },
  });

  await assert.rejects(() => client.bootstrapSession(), BookrSessionRefreshRequiredError);
  assert.equal(requestCount, 0);
  assert.equal(kv.values.size, 0);
});

test("Bookr rejects oversized or unauthenticated API responses without retaining bodies", async () => {
  const dashboard = `initialSubscription:{"id":"${subscriptionId}"}`;
  const oversized = createBookrClient({
    authCookie: authCookie(),
    fetchImpl: async (url) => url.endsWith("/dashboard")
      ? dashboardResponse(dashboard)
      : jsonResponse({}, { headers: { "content-length": String(512 * 1024 + 1) } }),
  });
  await oversized.bootstrapSession();
  await assert.rejects(() => oversized.listClasses("2026-09-05"), /size limit/);

  const rejected = createBookrClient({
    authCookie: authCookie(),
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  });
  await assert.rejects(() => rejected.bootstrapSession(), BookrLoginError);

  const invalidDate = createBookrClient({
    authCookie: authCookie(),
    fetchImpl: async () => {
      throw new Error("fetch must not be called for an invalid class date");
    },
  });
  await assert.rejects(() => invalidDate.listClasses("2026-02-30"), /YYYY-MM-DD/);

  for (const response of [
    new Response("<html>not json</html>", { headers: { "content-type": "text/html" } }),
    jsonResponse({ selectedDaySessions: "not-an-array" }),
  ]) {
    const malformed = createBookrClient({
      authCookie: authCookie(),
      fetchImpl: async (url) => url.endsWith("/dashboard")
        ? dashboardResponse(dashboard)
        : response.clone(),
    });
    await malformed.bootstrapSession();
    await assert.rejects(() => malformed.listClasses("2026-09-05"), /unexpected response type|invalid class calendar/);
  }
});

test("Bookr maps booking restrictions and prevents cancellation after the window closes", async () => {
  let enrollCalls = 0;
  const deadlineReached = normalizeBookrSession(apiSession({
    canBook: true,
    registrationDeadlineReached: true,
  }));
  await assert.rejects(
    () => runBookrOperation({
      client: {
        listClasses: async () => [deadlineReached],
        enroll: async () => { enrollCalls += 1; },
      },
      operation: "enroll",
      classDate: "2026-09-05",
      classTime: "07:30",
      classType: "WOD Rato",
    }),
    (error) => error instanceof BookrBookingError && error.reason === "registration_deadline_passed",
  );
  assert.equal(enrollCalls, 0);

  const booked = normalizeBookrSession(apiSession({
    currentUserBookingStatus: "booked",
    canBook: false,
    canCancel: false,
  }));
  await assert.rejects(
    () => runBookrOperation({
      client: { listClasses: async () => [booked] },
      operation: "unenroll",
      classDate: "2026-09-05",
      classTime: "07:30",
      classType: "WOD Rato",
    }),
    (error) => error instanceof BookrBookingError && error.reason === "cancellation_window_closed",
  );

  let dayReads = 0;
  const client = createBookrClient({
    authCookie: authCookie(),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/dashboard")) return dashboardResponse();
      if (url.includes("athlete-calendar/day")) {
        dayReads += 1;
        return jsonResponse({ selectedDaySessions: [apiSession({
          currentUserBookingStatus: "booked",
          canBook: false,
          canCancel: true,
        })] });
      }
      if (options.method === "DELETE") {
        return jsonResponse({ error: "cancellation_window_closed" }, { status: 400 });
      }
      throw new Error("unexpected request");
    },
  });
  await client.bootstrapSession();
  const selected = (await client.listClasses("2026-09-05"))[0];
  await assert.rejects(
    () => client.unenroll(selected),
    (error) => error instanceof BookrBookingError && error.reason === "cancellation_window_closed",
  );
  assert.equal(dayReads, 2);
});
