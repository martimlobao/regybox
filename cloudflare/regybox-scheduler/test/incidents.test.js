import assert from "node:assert/strict";
import test from "node:test";

import {
  incidentConstants,
  readIncident,
  recordIncident,
  rememberStatusOrigin,
  resolveStatusUrl,
} from "../src/incidents.js";
import { handleIncidentRequest } from "../src/status.js";
import { UnparseableError } from "../src/regybox.js";

function makeKv(entries = new Map()) {
  const writes = [];
  return {
    entries,
    writes,
    async get(key) { return entries.get(key) ?? null; },
    async put(key, value, options) {
      entries.set(key, value);
      writes.push({ key, value, options });
    },
  };
}

function dispatch() {
  return {
    operation: "enroll",
    inputs: {
      "class-type": "WOD Rato, Weekend WOD Rato",
      "class-date": "2026-07-16",
      "class-time": "06:30",
    },
  };
}

test("status origin is remembered and STATUS_URL remains an override", async () => {
  const kv = makeKv();
  await rememberStatusOrigin(kv, "https://worker.example.test/regybox?ignored=yes");
  assert.equal(await resolveStatusUrl({}, kv), "https://worker.example.test/regybox");
  assert.equal(
    await resolveStatusUrl({ STATUS_URL: "https://custom.example.test/custom/status/" }, kv),
    "https://custom.example.test/custom/status",
  );
  assert.equal(
    await resolveStatusUrl({ STATUS_URL: "not a URL" }, kv),
    "https://worker.example.test/regybox",
  );
  assert.equal(kv.writes[0].key, incidentConstants.STATUS_ORIGIN_KEY);
  assert.equal(kv.writes[0].options, undefined);
  await rememberStatusOrigin(kv, "https://worker.example.test/regybox?ignored=again");
  assert.equal(kv.writes.length, 1);
});

test("incident records are short-lived, sanitized, and render read-only", async () => {
  const kv = makeKv();
  const error = new UnparseableError(
    "<html><body>Unexpected https://calendar.google.test/private-secret/basic.ics " +
      'php/aulas/marca_aulas.php?id_aula=123&x=top-secret token=abc ' +
      '{"token":"json-secret"} Authorization: Bearer bearer-secret ' +
      "PHPSESSID php-secret</body></html>",
    { actionEndpoints: ["/app/app_nova/php/aulas/marca_aulas.php"] },
  );
  const unsafeDispatch = dispatch();
  unsafeDispatch.inputs["class-type"] =
    "WOD <b>unsafe</b>, https://calendar.google.test/class-secret/private.ics";
  unsafeDispatch.inputs["class-date"] = "php/aulas/marca_aulas.php?id=class-date-secret";
  const incidentUrl = await recordIncident({
    kv,
    dispatch: unsafeDispatch,
    error,
    payload: { errorCode: "unparseable_response", technicalMessage: error.message },
    statusUrl: "https://worker.example.test/regybox",
    now: () => Date.parse("2026-07-13T12:00:00Z"),
  });
  const id = incidentUrl.split("/").at(-1);
  assert.equal(incidentUrl, `https://worker.example.test/regybox/incidents/${id}`);
  const record = await readIncident(kv, id);

  assert.equal(kv.writes[0].options.expirationTtl, 604800);
  assert.deepEqual(record.classCandidates, ["WOD unsafe", "[redacted URL]"]);
  assert.doesNotMatch(
    JSON.stringify(record),
    /<html|<body|<b>|private-secret|class-secret|basic\.ics|private\.ics|marca_aulas\.php\?|top-secret|token=abc|json-secret|bearer-secret|php-secret|id_aula=123/,
  );
  assert.deepEqual(record.parserDiagnostics.actionEndpoints, [
    "/app/app_nova/php/aulas/marca_aulas.php",
  ]);

  const response = await handleIncidentRequest(kv, id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await response.text(), /expires automatically after 7 days/);
});

test("invalid or expired incident IDs return a no-store 404", async () => {
  const response = await handleIncidentRequest(makeKv(), "not-an-id");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("corrupt incident records return 404 and leave a diagnostic warning", async () => {
  const id = "0123456789abcdef0123456789abcdef0123";
  const kv = makeKv(new Map([[`regybox:v1:incident:${id}`, "not-json"]]));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const response = await handleIncidentRequest(kv, id);
    assert.equal(response.status, 404);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(String(warnings[0]?.[0]), /incident read failed/);
});
