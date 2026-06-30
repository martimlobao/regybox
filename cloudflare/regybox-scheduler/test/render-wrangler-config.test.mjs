import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRepoDotEnv, renderWranglerConfig } from "../scripts/render-wrangler-config.mjs";

const template = `{
  "kv_namespaces": [
    { "binding": "REGYBOX_STATE", "id": "replace-with-your-kv-namespace-id" }
  ]
}`;

test("renderWranglerConfig substitutes the kv namespace id", () => {
  const rendered = renderWranglerConfig(template, "test-kv-namespace-id");
  assert.match(rendered, /test-kv-namespace-id/);
  assert.doesNotMatch(rendered, /replace-with-your-kv-namespace-id/);
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
