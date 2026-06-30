import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectWorkerVars,
  loadRepoDotEnv,
  renderWranglerConfig,
} from "../scripts/render-wrangler-config.mjs";

const template = `{
  "keep_vars": true,
  "kv_namespaces": [
    { "binding": "REGYBOX_STATE", "id": "replace-with-your-kv-namespace-id" }
  ]
}`;

test("renderWranglerConfig substitutes the kv namespace id", () => {
  const rendered = JSON.parse(renderWranglerConfig(template, "test-kv-namespace-id"));
  assert.equal(rendered.kv_namespaces[0].id, "test-kv-namespace-id");
  assert.equal(rendered.vars, undefined);
});

test("renderWranglerConfig injects worker vars from env", () => {
  const rendered = JSON.parse(
    renderWranglerConfig(template, "test-kv-namespace-id", {
      GITHUB_OWNER: "example-owner",
      CLASS_TYPE: "WOD",
    }),
  );
  assert.deepEqual(rendered.vars, {
    GITHUB_OWNER: "example-owner",
    CLASS_TYPE: "WOD",
  });
});

test("collectWorkerVars ignores empty values", () => {
  assert.deepEqual(
    collectWorkerVars({
      GITHUB_OWNER: " example-owner ",
      GITHUB_REPO: "   ",
      LOOKAHEAD_HOURS: "73",
    }),
    {
      GITHUB_OWNER: "example-owner",
      LOOKAHEAD_HOURS: "73",
    },
  );
});

test("renderWranglerConfig rejects a missing namespace id", () => {
  assert.throws(
    () => renderWranglerConfig(template, ""),
    /CF_KV_NAMESPACE_ID is required/,
  );
});

test("loadRepoDotEnv reads cf kv namespace id from repo .env", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "regybox-env-"));
  writeFileSync(join(repoRoot, ".env"), "CF_KV_NAMESPACE_ID=test-namespace-id\n");
  const previous = process.env.CF_KV_NAMESPACE_ID;
  delete process.env.CF_KV_NAMESPACE_ID;
  try {
    loadRepoDotEnv(repoRoot);
    assert.equal(process.env.CF_KV_NAMESPACE_ID, "test-namespace-id");
  } finally {
    if (previous === undefined) {
      delete process.env.CF_KV_NAMESPACE_ID;
    } else {
      process.env.CF_KV_NAMESPACE_ID = previous;
    }
  }
});
