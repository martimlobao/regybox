import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ClassIsOverbookedError,
  ClassNotOpenError,
  ClassNotFoundError,
  NoClassesFoundError,
  RegyboxLoginError,
  RegyboxTimeoutError,
  UnparseableError,
  createRegyboxClient,
  parseClass,
  parseCapacity,
  parseClasses,
  pickClass,
  pickFirstClass,
  runOperation,
} from "../src/regybox.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(testDirectory, "fixtures");
const sourceFixtureDirectory = join(testDirectory, "../../../tests/html_examples");

async function fixture(name) {
  return readFile(join(fixtureDirectory, name), "utf8");
}

async function parsedFixture(name) {
  return parseClasses(await fixture(name), { timezone: "Europe/Lisbon" })[0];
}

test("Worker fixture copies remain byte-identical to Python fixtures when available", async (t) => {
  let sourceFiles;
  try {
    sourceFiles = (await readdir(sourceFixtureDirectory)).filter((file) => file.endsWith(".html"));
  } catch (error) {
    if (error.code === "ENOENT") {
      t.skip("Python fixture directory is not included in this checkout");
      return;
    }
    throw error;
  }
  const localFiles = (await readdir(fixtureDirectory)).filter((file) => file.endsWith(".html"));
  assert.deepEqual(localFiles.sort(), sourceFiles.sort());
  for (const name of sourceFiles) {
    assert.deepEqual(await readFile(join(fixtureDirectory, name)), await readFile(join(sourceFixtureDirectory, name)));
  }
});

test("every class fixture retains the Python classification", async (t) => {
  const expectations = {
    "finished.html": {
      isOpen: false, isFull: false, isOverbooked: false, isOver: true, userIsBlocked: true,
      userIsEnrolled: false, userIsWaitlisted: false, timeToStart: null, timeToEnroll: null,
      enrollUrl: null, unenrollUrl: null,
    },
    "open.html": {
      isOpen: true, isOverbooked: false, isOver: false, userIsBlocked: false, userIsEnrolled: false,
      userIsWaitlisted: false, timeToEnroll: null, unenrollUrl: null, enrollUrl: true, timeToStart: true,
    },
    "registered.html": {
      isOpen: true, isOver: false, userIsBlocked: false, userIsEnrolled: true, userIsWaitlisted: false,
      timeToStart: null, timeToEnroll: null, enrollUrl: null, unenrollUrl: true,
    },
    "in_progress.html": {
      isOpen: false, isOver: false, timeToStart: null, timeToEnroll: null, enrollUrl: null, unenrollUrl: null,
    },
    "unenroll_closed.html": {
      isOpen: false, isOver: false, userIsBlocked: false, userIsEnrolled: true,
      timeToStart: null, timeToEnroll: null, enrollUrl: null, unenrollUrl: null,
    },
    "closed_starting_soon.html": {
      isOpen: false, isFull: false, isOverbooked: false, enrollmentDeadlineExpired: true, isOver: false,
      timeToStart: null, timeToEnroll: null, enrollUrl: null, unenrollUrl: null,
    },
    "full.html": {
      isOpen: true, isFull: true, isOverbooked: false, isOver: false, userIsBlocked: false,
      userIsEnrolled: false, userIsWaitlisted: false, timeToEnroll: null, unenrollUrl: null,
      enrollUrl: true, timeToStart: true,
    },
    "overbooked.html": {
      name: "WOD Rato", details: "Rato", date: "2026-06-23", start: "06:30", end: "07:20",
      curCapacity: 18, maxCapacity: 14, isOpen: false, isFull: true, isOverbooked: true,
      isOver: false, userIsBlocked: true, userIsEnrolled: false, userIsWaitlisted: false,
      timeToStart: null, timeToEnroll: null, enrollUrl: null, unenrollUrl: null,
    },
    "registered_for_other.html": {
      isOpen: true, isOverbooked: false, isOver: false, userIsBlocked: true, userIsEnrolled: false,
      userIsWaitlisted: false, timeToStart: null, timeToEnroll: null, enrollUrl: null, unenrollUrl: null,
    },
    "waitlisted.html": {
      isOpen: true, isFull: true, isOverbooked: false, isOver: false, userIsBlocked: false,
      userIsEnrolled: true, userIsWaitlisted: true, timeToStart: null, timeToEnroll: null,
      enrollUrl: null, unenrollUrl: true,
    },
    "not_yet_open.html": {
      isOpen: false, isFull: false, isOverbooked: false, isOver: false, userIsBlocked: true,
      userIsEnrolled: false, userIsWaitlisted: false, timeToStart: null, enrollUrl: null, unenrollUrl: null,
      timeToEnroll: true,
    },
    "unlimited.html": {
      isOpen: false, isFull: false, maxCapacity: null, curCapacity: 0, isOverbooked: false,
      isOver: false, userIsWaitlisted: false, timeToStart: null, enrollUrl: null, unenrollUrl: null,
      timeToEnroll: true,
    },
  };
  for (const [name, expected] of Object.entries(expectations)) {
    await t.test(name, async () => {
      const class_ = await parsedFixture(name);
      for (const [key, value] of Object.entries(expected)) {
        if (["enrollUrl", "unenrollUrl", "timeToStart", "timeToEnroll"].includes(key) && value === true) {
          assert.ok(class_[key], `${name}: ${key}`);
        } else {
          assert.equal(class_[key], value, `${name}: ${key}`);
        }
      }
    });
  }
  await t.test("bad_class.html", async () => {
    const html = await fixture("bad_class.html");
    assert.throws(() => parseClass(html), UnparseableError);
  });
});

test("capacity and picker preserve Python contracts", async () => {
  assert.equal(parseCapacity("∞"), null);
  assert.throws(() => parseCapacity("12/34"), UnparseableError);
  const openClass = await parsedFixture("open.html");
  const fallback = { ...openClass, name: "Weekend WOD" };
  assert.equal(
    pickFirstClass([fallback], {
      classTime: "06:30", classTypes: "WOD, Weekend WOD", classDate: fallback.date,
    }),
    fallback,
  );
  assert.throws(
    () => pickClass([openClass], { classTime: "07:00", classType: "WOD Rato", classDate: openClass.date }),
    ClassNotFoundError,
  );
  assert.throws(
    () => pickFirstClass([], { classTime: "06:30", classTypes: [], classDate: "2026-03-10" }),
    ClassNotFoundError,
  );
});

test("client sends the Python-compatible session and class requests", async () => {
  const requests = [];
  const client = createRegyboxClient({
    phpsessid: "session", regyboxUser: "123", retryTotal: 0,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response("ok");
    },
  });
  await client.bootstrapSession();
  await client.fetchClassesHtml(123456);
  assert.equal(requests[0].url.pathname, "/app/app_nova/set_session.php");
  assert.equal(requests[0].url.searchParams.get("z"), "123");
  assert.equal(requests[0].url.searchParams.get("y"), "*123");
  assert.equal(requests[0].url.searchParams.get("ignore"), "regybox.pt/app/app");
  assert.equal(requests[0].options.headers.Cookie, "PHPSESSID=session; regybox_boxes=%2A123; regybox_user=123");
  assert.equal(requests[0].options.headers.Referer, "https://www.regybox.pt/app/app_nova/");
  assert.equal(requests[0].options.headers["X-Requested-With"], "XMLHttpRequest");
  assert.equal(requests[1].url.pathname, "/app/app_nova/php/aulas/aulas.php");
  assert.deepEqual(Object.fromEntries(requests[1].url.searchParams), {
    valor1: "123456", type: "", source: "mes", scroll: "s", box: "", plano: "0", z: "123",
  });
});

test("client retries bounded statuses, handles login expiry, and parses action responses", async () => {
  let calls = 0;
  const waits = [];
  const traces = [];
  const client = createRegyboxClient({
    phpsessid: "session", regyboxUser: "123", retryTotal: 2, retryBackoffMs: 3,
    sleep: async (milliseconds) => waits.push(milliseconds),
    onTrace: async (event) => traces.push(event),
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? new Response("retry", { status: 503 }) : new Response('<script>parent.msg_toast_icon("Inscrito", "ok");</script>');
    },
  });
  assert.deepEqual(await client.enroll("php/aulas/marca_aulas.php?id=1"), { message: "Inscrito", userIsWaitlisted: false });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3, 6]);
  assert.equal(traces.filter((event) => event.code === "regybox_request_retry").length, 2);
  assert.ok(traces.every((event) => event.data.endpointPath === "/app/app_nova/php/aulas/marca_aulas.php"));
  assert.doesNotMatch(JSON.stringify(traces), /id=1|PHPSESSID|session/);
  const expired = createRegyboxClient({
    phpsessid: "session", regyboxUser: "123", retryTotal: 0,
    fetchImpl: async () => new Response("app/app_nova/login.php"),
  });
  await assert.rejects(expired.fetchClassesHtml(1), RegyboxLoginError);
});

test("client retries transient fetch failures within its bounded budget", async () => {
  let calls = 0;
  const waits = [];
  const client = createRegyboxClient({
    phpsessid: "session", regyboxUser: "123", retryTotal: 2, retryBackoffMs: 4,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError("temporary network failure");
      }
      return new Response("classes");
    },
  });
  assert.equal(await client.fetchClassesHtml(1), "classes");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [4, 8]);
});

function makeStubClient(responses) {
  const calls = { fetch: 0, enroll: [], unenroll: [] };
  return {
    timezone: "Europe/Lisbon",
    calls,
    async fetchClassesHtml() {
      const response = responses[Math.min(calls.fetch, responses.length - 1)];
      calls.fetch += 1;
      return response;
    },
    async enroll(url) { calls.enroll.push(url); return { message: "OK", userIsWaitlisted: false }; },
    async unenroll(url) { calls.unenroll.push(url); return { message: "OK", userIsWaitlisted: false }; },
  };
}

function withTimer(html, seconds) {
  return html.replace(/(<input\b[^>]*\bclass="[^"]*\btimers\b[^"]*"[^>]*\bvalue=")\d+("[^>]*>)/i, `$1${seconds}$2`);
}

test("runOperation retries a transient empty class list like Python's get_classes", async () => {
  const open = await fixture("open.html");
  const emptyThenOpen = makeStubClient(["<html></html>", "<html></html>", open]);
  const waits = [];
  assert.deepEqual(
    await runOperation({
      client: emptyThenOpen, classDate: "2024-07-01", classTime: "06:30", classType: "WOD Rato",
      timeoutSeconds: 60, sleep: async (milliseconds) => waits.push(milliseconds),
    }),
    { operation: "enroll", status: "success", classType: "WOD Rato" },
  );
  assert.equal(emptyThenOpen.calls.fetch, 3);
  assert.deepEqual(waits, [50, 100]);

  const alwaysEmpty = makeStubClient(["<html></html>"]);
  await assert.rejects(
    runOperation({
      client: alwaysEmpty, classDate: "2024-07-01", classTime: "06:30", classType: "WOD Rato",
      timeoutSeconds: 60, sleep: async () => {},
    }),
    NoClassesFoundError,
  );
  assert.equal(alwaysEmpty.calls.fetch, 4);
});

test("runOperation filters class cards by time without changing missing-class semantics", async () => {
  const open = await fixture("open.html");
  const otherTime = open.replaceAll("06:30", "05:30").replaceAll("07:20", "06:20");
  const allClasses = parseClasses(`${otherTime}${open}`, { timezone: "Europe/Lisbon" });
  const expected = pickFirstClass(allClasses, {
    classTime: "06:30", classTypes: "WOD Rato", classDate: "2024-07-01",
  });
  const matchingClient = makeStubClient([`${otherTime}${open}`]);
  assert.deepEqual(
    await runOperation({
      client: matchingClient, classDate: "2024-07-01", classTime: "06:30", classType: "WOD Rato",
      timeoutSeconds: 60,
    }),
    { operation: "enroll", status: "success", classType: expected.name },
  );

  const encodedTimeClient = makeStubClient([open.replaceAll("06:30", "06&#58;30")]);
  assert.deepEqual(
    await runOperation({
      client: encodedTimeClient, classDate: "2024-07-01", classTime: "06:30", classType: "WOD Rato",
      timeoutSeconds: 60,
    }),
    { operation: "enroll", status: "success", classType: expected.name },
  );

  const wrongTimeClient = makeStubClient([open]);
  await assert.rejects(
    runOperation({
      client: wrongTimeClient, classDate: "2024-07-01", classTime: "07:30", classType: "WOD Rato",
      timeoutSeconds: 60,
    }),
    ClassNotFoundError,
  );
  assert.equal(wrongTimeClient.calls.fetch, 1);

  const emptyClient = makeStubClient(["<html></html>"]);
  await assert.rejects(
    runOperation({
      client: emptyClient, classDate: "2024-07-01", classTime: "06:30", classType: "WOD Rato",
      timeoutSeconds: 60, sleep: async () => {},
    }),
    NoClassesFoundError,
  );
  assert.equal(emptyClient.calls.fetch, 4);
});

test("action controls are classified by endpoint instead of CSS classes", async () => {
  const open = await fixture("open.html");
  const registered = await fixture("registered.html");
  const classlessOpen = open.replace(/<button class="[^"]+"/, "<button");
  const classlessRegistered = registered.replace(/<button class="[^"]+"/, "<button");

  assert.ok(parseClass(classlessOpen).enrollUrl?.includes("/marca_aulas.php?"));
  assert.ok(parseClass(classlessRegistered).unenrollUrl?.includes("/cancela_aula.php?"));

  const withUnrelatedButton = open.replace(
    /(<button\b)/,
    '<button onclick="show_help()">Help</button>$1',
  );
  assert.ok(parseClass(withUnrelatedButton).enrollUrl?.includes("/marca_aulas.php?"));

  const withUnrelatedPhpButton = open.replace(
    /(<button\b)/,
    '<button onclick="php/aulas/class_details.php?id=private">Details</button>$1',
  );
  assert.ok(parseClass(withUnrelatedPhpButton).enrollUrl?.includes("/marca_aulas.php?"));

  const withColoredHelpButton = open.replace(
    /(<button\b)/,
    '<button class="button color-green" onclick="php/aulas/class_details.php?id=private">Help</button>$1',
  );
  assert.ok(parseClass(withColoredHelpButton).enrollUrl?.includes("/marca_aulas.php?"));

  const literalGreaterThanInOnclick = open.replace(
    "javascript:load_script",
    "javascript:if (1 > 0) load_script",
  );
  assert.ok(parseClass(literalGreaterThanInOnclick).enrollUrl?.includes("/marca_aulas.php?"));
});

test("unknown and ambiguous class action endpoints fail with secret-safe diagnostics", async () => {
  const open = await fixture("open.html");
  const malformed = open.replace(/\bonclick="[^"]*"/, 'onclick="show_booking_dialog()"');
  assert.throws(
    () => parseClass(malformed),
    (error) => {
      assert.ok(error instanceof UnparseableError);
      assert.match(error.message, /recognizable class action/);
      assert.deepEqual(error.safeDiagnostics, {
        actionEndpoints: [],
        unknownActionEndpoints: [],
        malformedBookingControls: 1,
      });
      return true;
    },
  );

  const unknown = open.replace("marca_aulas.php", "new_booking_action.php");
  assert.throws(
    () => parseClass(unknown),
    (error) => {
      assert.ok(error instanceof UnparseableError);
      assert.match(error.message, /\/new_booking_action\.php/);
      assert.doesNotMatch(error.message, /id_aula|00113455677789aabcddddeeefff/);
      return true;
    },
  );

  const offOrigin = open.replace(
    /\.\.\/app_nova\/php\/aulas\/marca_aulas\.php/,
    "https://attacker.example/app/app_nova/php/aulas/marca_aulas.php",
  );
  assert.throws(
    () => parseClass(offOrigin),
    (error) => {
      assert.ok(error instanceof UnparseableError);
      assert.match(error.message, /unexpected origin or path/);
      assert.doesNotMatch(error.message, /attacker\.example|id_aula/);
      assert.deepEqual(error.safeDiagnostics, {
        actionEndpoints: [],
        unexpectedOriginEndpoints: ["/app/app_nova/php/aulas/marca_aulas.php"],
      });
      return true;
    },
  );

  const ambiguous = open.replace(
    /(<button\b)/,
    '<button onclick="php/aulas/cancela_aula.php?id_aula=secret-token">Cancel</button>$1',
  );
  assert.throws(
    () => parseClass(ambiguous),
    (error) => {
      assert.ok(error instanceof UnparseableError);
      assert.match(error.message, /Ambiguous class action controls/);
      assert.doesNotMatch(error.message, /secret-token|id_aula/);
      return true;
    },
  );
});

test("an unrelated malformed same-time class cannot abort the requested class", async () => {
  const open = await fixture("open.html");
  const unrelatedMalformed = open
    .replace("WOD Rato", "Yoga")
    .replace("marca_aulas.php", "unknown_action.php");
  const client = makeStubClient([`${unrelatedMalformed}${open}`]);

  assert.deepEqual(
    await runOperation({
      client,
      classDate: "2024-07-01",
      classTime: "06:30",
      classType: "WOD Rato, Weekend WOD Rato",
      timeoutSeconds: 60,
    }),
    { operation: "enroll", status: "success", classType: "WOD Rato" },
  );
});

test("runOperation enrolls, waitlists, and handles enrollment noops", async () => {
  const open = await fixture("open.html");
  const full = await fixture("full.html");
  const registered = await fixture("registered.html");
  const base = { classDate: "2024-07-01", classTime: "06:30", classType: "WOD Rato", timeoutSeconds: 60 };
  const openClient = makeStubClient([open]);
  assert.deepEqual(await runOperation({ client: openClient, ...base, classTime: "6:30" }), {
    operation: "enroll", status: "success", classType: "WOD Rato",
  });
  assert.equal(openClient.calls.enroll.length, 1);
  const fullClient = makeStubClient([full]);
  assert.deepEqual(await runOperation({ client: fullClient, ...base, classDate: "2024-06-29", classTime: "10:00", classType: "Aulão Benfica" }), {
    operation: "enroll", status: "success", classType: "Aulão Benfica",
  });
  assert.equal(fullClient.calls.enroll.length, 1);
  const enrolledClient = makeStubClient([registered]);
  assert.deepEqual(await runOperation({ client: enrolledClient, ...base, classDate: "2024-05-09" }), {
    operation: "enroll", status: "noop", classType: "WOD Rato",
  });
  assert.equal(enrolledClient.calls.enroll.length, 0);
});

test("runOperation waits within the Worker poll cap and returns structured not-open noops", async () => {
  const closed = await fixture("not_yet_open.html");
  const open = (await fixture("open.html")).replaceAll("06:30", "07:30").replaceAll("07:20", "08:20");
  let clock = Date.parse("2024-07-01T00:00:00Z");
  const client = makeStubClient([closed, open]);
  const result = await runOperation({
    client, classDate: "2024-07-01", classTime: "07:30", classType: "WOD Rato", timeoutSeconds: 900,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });
  assert.equal(result.status, "success");
  assert.equal(client.calls.fetch, 2);

  const notOpenClient = makeStubClient([closed]);
  const noop = await runOperation({
    client: notOpenClient, classDate: "2024-07-01", classTime: "07:30", classType: "WOD Rato", timeoutSeconds: 60,
    notOpenIsNoop: true, now: () => clock,
  });
  assert.deepEqual({ operation: noop.operation, status: noop.status, cacheState: noop.cacheState }, {
    operation: "enroll", status: "noop", cacheState: "not_open",
  });
  assert.match(noop.enrollmentOpensAt, /^2024-07-01T/);
  assert.match(noop.lastCheckedAt, /^2024-07-01T/);
});

test("runOperation matches Python polling cadence at the enrollment boundary", async () => {
  const closed = await fixture("not_yet_open.html");
  const open = (await fixture("open.html")).replaceAll("06:30", "07:30").replaceAll("07:20", "08:20");
  let clock = Date.parse("2024-07-01T00:00:00Z");
  const waits = [];
  const traces = [];
  const client = makeStubClient([
    withTimer(closed, 58),
    withTimer(closed, 4),
    withTimer(closed, 3),
    withTimer(closed, 2),
    open,
  ]);

  const result = await runOperation({
    client,
    classDate: "2024-07-01",
    classTime: "07:30",
    classType: "WOD Rato",
    timeoutSeconds: 120,
    now: () => clock,
    sleep: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
    onTrace: async (event) => traces.push(event),
  });

  assert.equal(result.status, "success");
  assert.deepEqual(waits, [10_000, 1_000, 1_000, 1_000]);
  assert.ok(traces.some((event) => event.message === "Opening in 4 seconds; retrying in 1 second"));
  assert.equal(client.calls.fetch, 5);
});

test("runOperation treats a post-countdown timer rollover as an inconsistency and keeps polling", async () => {
  const closed = await fixture("not_yet_open.html");
  const open = (await fixture("open.html")).replaceAll("06:30", "07:30").replaceAll("07:20", "08:20");
  let clock = Date.parse("2024-07-01T00:00:00Z");
  const traces = [];
  const client = makeStubClient([withTimer(closed, 2), withTimer(closed, 213_598), open]);

  const result = await runOperation({
    client,
    classDate: "2024-07-01",
    classTime: "07:30",
    classType: "WOD Rato",
    timeoutSeconds: 60,
    notOpenIsNoop: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    onTrace: async (event) => traces.push(event),
  });

  assert.equal(result.status, "success");
  assert.equal(client.calls.fetch, 3);
  const anomaly = traces.find((event) => event.code === "opening_boundary_inconsistency");
  assert.ok(anomaly);
  assert.equal(anomaly.data.timerSeconds, 213_598);
  assert.doesNotMatch(JSON.stringify(traces), /id_aula|PHPSESSID|<div/i);
});

test("runOperation fails instead of caching a timer rollover that persists through grace", async () => {
  const closed = await fixture("not_yet_open.html");
  let clock = Date.parse("2024-07-01T00:00:00Z");
  const client = makeStubClient([withTimer(closed, 1), withTimer(closed, 213_598)]);

  await assert.rejects(
    runOperation({
      client,
      classDate: "2024-07-01",
      classTime: "07:30",
      classType: "WOD Rato",
      timeoutSeconds: 60,
      notOpenIsNoop: true,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }),
    (error) => {
      assert.ok(error instanceof UnparseableError);
      assert.equal(error.safeDiagnostics.timerSeconds, 213_598);
      return true;
    },
  );
  assert.equal(client.calls.enroll.length, 0);
  assert.ok(client.calls.fetch >= 30);
});

test("runOperation fails at the defensive fetch ceiling and after a waited timeout", async () => {
  const closed = await fixture("not_yet_open.html");
  let clock = Date.parse("2024-07-01T00:00:00Z");
  const pollingClient = makeStubClient([withTimer(closed, 1)]);
  await assert.rejects(
    runOperation({
      client: pollingClient,
      classDate: "2024-07-01",
      classTime: "07:30",
      classType: "WOD Rato",
      timeoutSeconds: 900,
      notOpenIsNoop: true,
      maxPolls: 3,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }),
    RegyboxTimeoutError,
  );
  assert.equal(pollingClient.calls.fetch, 3);

  clock = Date.parse("2024-07-01T00:00:00Z");
  await assert.rejects(
    runOperation({
      client: makeStubClient([withTimer(closed, 1)]),
      classDate: "2024-07-01",
      classTime: "07:30",
      classType: "WOD Rato",
      timeoutSeconds: 2,
      notOpenIsNoop: true,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }),
    RegyboxTimeoutError,
  );
});

test("runOperation preserves closed, overbooked, and unenroll behavior", async () => {
  const closed = await fixture("closed_starting_soon.html");
  const overbooked = await fixture("overbooked.html");
  const registered = await fixture("registered.html");
  const unenrollClosed = await fixture("unenroll_closed.html");
  await assert.rejects(
    runOperation({ client: makeStubClient([closed]), classDate: "2024-06-28", classTime: "19:30", classType: "WOD Rato", timeoutSeconds: 60 }),
    ClassNotOpenError,
  );
  await assert.rejects(
    runOperation({ client: makeStubClient([overbooked]), classDate: "2026-06-23", classTime: "06:30", classType: "WOD Rato", timeoutSeconds: 60 }),
    ClassIsOverbookedError,
  );
  const enrolledClient = makeStubClient([registered]);
  assert.deepEqual(await runOperation({
    client: enrolledClient, operation: "unenroll", classDate: "2024-05-09", classTime: "06:30", classType: "Missing, WOD Rato",
  }), { operation: "unenroll", status: "success", classType: "WOD Rato" });
  assert.equal(enrolledClient.calls.unenroll.length, 1);
  await assert.rejects(
    runOperation({
      client: makeStubClient([unenrollClosed]), operation: "unenroll", classDate: "2024-05-13",
      classTime: "13:00", classType: "WOD Rato",
    }),
    UnparseableError,
  );
  const missingClient = makeStubClient([registered]);
  assert.deepEqual(await runOperation({
    client: missingClient, operation: "unenroll", classDate: "2024-05-09", classTime: "06:30", classType: "Missing",
  }), { operation: "unenroll", status: "noop", classType: "Missing" });
  await assert.rejects(
    runOperation({ client: makeStubClient([await fixture("not_yet_open.html")]), classDate: "2024-07-01", classTime: "07:30", classType: "WOD Rato", timeoutSeconds: 60 }),
    RegyboxTimeoutError,
  );
});
