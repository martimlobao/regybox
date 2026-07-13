import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  mergeDeploymentConfig,
  updateFromUpstream,
} from "../scripts/update-from-upstream.mjs";

const upstreamConfig = `{
  "name": "regybox-scheduler",
  "vars": {
    "CLASS_MAP": "CrossFit = WOD",
    "TIMEZONE": "Europe/Lisbon"
  },
  "kv_namespaces": [{ "binding": "REGYBOX_STATE" }],
  "triggers": { "crons": ["28,58 * * * *"] }
}`;

const deploymentConfig = `{
  "name": "ana-regybox",
  "keep_vars": true,
  "vars": {
    "CLASS_MAP": "Yoga = Yoga",
    "TIMEZONE": "Europe/Madrid"
  },
  "kv_namespaces": [{ "binding": "REGYBOX_STATE", "id": "ana-kv" }]
}`;

test("automatic updates keep the Worker identity and dashboard-owned variables", () => {
  const merged = JSON.parse(
    mergeDeploymentConfig({ deploymentText: deploymentConfig, upstreamText: upstreamConfig }),
  );

  assert.equal(merged.name, "ana-regybox");
  assert.equal(merged.keep_vars, true);
  assert.equal(merged.kv_namespaces[0].id, "ana-kv");
  assert.equal(merged.vars, undefined);
  assert.deepEqual(merged.triggers, { crons: ["28,58 * * * *"] });
});

test("automatic updates replace managed code while leaving personal files alone", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-updater-"));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(target, "src"), { recursive: true });
  mkdirSync(join(source, ".git"), { recursive: true });
  mkdirSync(join(target, ".git"), { recursive: true });
  writeFileSync(join(source, "wrangler.jsonc"), upstreamConfig);
  writeFileSync(join(source, "src", "worker.js"), "export const version = 2;\n");
  writeFileSync(join(source, ".git", "HEAD"), "upstream metadata\n");
  writeFileSync(join(target, "wrangler.jsonc"), deploymentConfig);
  writeFileSync(join(target, "src", "worker.js"), "export const version = 1;\n");
  writeFileSync(join(target, ".git", "HEAD"), "personal metadata\n");
  writeFileSync(join(target, ".dev.vars"), "PHPSESSID=personal\n");

  updateFromUpstream({ sourceDirectory: source, targetDirectory: target });

  assert.equal(readFileSync(join(target, "src", "worker.js"), "utf8"), "export const version = 2;\n");
  assert.equal(readFileSync(join(target, ".dev.vars"), "utf8"), "PHPSESSID=personal\n");
  assert.equal(readFileSync(join(target, ".git", "HEAD"), "utf8"), "personal metadata\n");
  const updatedConfig = JSON.parse(readFileSync(join(target, "wrangler.jsonc"), "utf8"));
  assert.equal(updatedConfig.name, "ana-regybox");
  assert.equal(updatedConfig.vars, undefined);
});

test("automatic updates ignore unsafe paths from an old updater manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-updater-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const outside = join(root, "do-not-delete.txt");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(source, "wrangler.jsonc"), upstreamConfig);
  writeFileSync(join(target, "wrangler.jsonc"), deploymentConfig);
  writeFileSync(outside, "keep me\n");
  writeFileSync(
    join(target, ".regybox-updater-files.json"),
    '{"files":["../../do-not-delete.txt"]}\n',
  );

  updateFromUpstream({ sourceDirectory: source, targetDirectory: target });

  assert.equal(readFileSync(outside, "utf8"), "keep me\n");
});
