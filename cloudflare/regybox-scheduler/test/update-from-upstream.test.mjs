import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  mergeDeploymentConfig,
  updateFromUpstream,
} from "../scripts/update-from-upstream.mjs";
import { stripJsoncComments } from "../scripts/render-wrangler-config.mjs";

const upstreamConfig = `{
  "$schema": "https://example.test/wrangler.schema.json",
  "name": "regybox-scheduler",
  "vars": {
    "CLASS_MAP": "CrossFit = WOD",
    "TIMEZONE": "Europe/Lisbon"
  },
  "kv_namespaces": [{ "binding": "REGYBOX_STATE" }],
  "triggers": { "crons": ["28,58 * * * *"] } // keep schedule current
}`;

const deploymentConfig = `{
  "name": "ana-regybox",
  "keep_vars": true,
  "vars": {
    "CLASS_MAP": "Yoga = Yoga",
    "TIMEZONE": "Europe/Madrid",
    "STATUS_URL": "https://worker.example.test/regybox"
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
  assert.equal(merged.$schema, "https://example.test/wrangler.schema.json");
});

test("automatic updates preserve deployment KV bindings when upstream bindings are absent", () => {
  for (const upstreamNamespaces of [undefined, []]) {
    const upstream = JSON.parse(stripJsoncComments(upstreamConfig));
    if (upstreamNamespaces === undefined) {
      delete upstream.kv_namespaces;
    } else {
      upstream.kv_namespaces = upstreamNamespaces;
    }
    const merged = JSON.parse(
      mergeDeploymentConfig({
        deploymentText: deploymentConfig,
        upstreamText: JSON.stringify(upstream),
      }),
    );
    assert.deepEqual(merged.kv_namespaces, [
      { binding: "REGYBOX_STATE", id: "ana-kv" },
    ]);
  }
});

test("automatic updates tolerate absent or empty deployment KV bindings", () => {
  for (const deploymentNamespaces of [undefined, []]) {
    const deployment = JSON.parse(deploymentConfig);
    if (deploymentNamespaces === undefined) {
      delete deployment.kv_namespaces;
    } else {
      deployment.kv_namespaces = deploymentNamespaces;
    }
    const merged = JSON.parse(
      mergeDeploymentConfig({
        deploymentText: JSON.stringify(deployment),
        upstreamText: upstreamConfig,
      }),
    );
    assert.deepEqual(merged.kv_namespaces, [{ binding: "REGYBOX_STATE" }]);
  }
});

test("automatic updates retain deployment-owned extra KV bindings", () => {
  const deployment = JSON.parse(deploymentConfig);
  deployment.kv_namespaces.push({ binding: "PERSONAL_DATA", id: "personal-kv" });
  const merged = JSON.parse(
    mergeDeploymentConfig({
      deploymentText: JSON.stringify(deployment),
      upstreamText: upstreamConfig,
    }),
  );
  assert.deepEqual(merged.kv_namespaces, [
    { binding: "REGYBOX_STATE", id: "ana-kv" },
    { binding: "PERSONAL_DATA", id: "personal-kv" },
  ]);
});

test("automatic updates replace managed code while leaving personal files alone", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-updater-"));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(target, "src"), { recursive: true });
  mkdirSync(join(source, ".git"), { recursive: true });
  mkdirSync(join(source, ".github", "workflows"), { recursive: true });
  mkdirSync(join(target, ".git"), { recursive: true });
  mkdirSync(join(target, ".github", "workflows"), { recursive: true });
  writeFileSync(join(source, "wrangler.jsonc"), upstreamConfig);
  writeFileSync(join(source, "src", "worker.js"), "export const version = 2;\n");
  writeFileSync(join(source, ".git", "HEAD"), "upstream metadata\n");
  writeFileSync(join(source, ".github", "workflows", "upstream.yml"), "upstream\n");
  writeFileSync(join(target, "wrangler.jsonc"), deploymentConfig);
  writeFileSync(join(target, "src", "worker.js"), "export const version = 1;\n");
  writeFileSync(join(target, ".git", "HEAD"), "personal metadata\n");
  writeFileSync(join(target, ".github", "workflows", "personal.yml"), "personal\n");
  writeFileSync(join(target, ".dev.vars"), "PHPSESSID=personal\n");

  updateFromUpstream({ sourceDirectory: source, targetDirectory: target });

  assert.equal(readFileSync(join(target, "src", "worker.js"), "utf8"), "export const version = 2;\n");
  assert.equal(readFileSync(join(target, ".dev.vars"), "utf8"), "PHPSESSID=personal\n");
  assert.equal(readFileSync(join(target, ".git", "HEAD"), "utf8"), "personal metadata\n");
  assert.equal(
    readFileSync(join(target, ".github", "workflows", "personal.yml"), "utf8"),
    "personal\n",
  );
  assert.equal(
    existsSync(join(target, ".github", "workflows", "upstream.yml")),
    false,
  );
  const updatedConfig = JSON.parse(readFileSync(join(target, "wrangler.jsonc"), "utf8"));
  assert.equal(updatedConfig.name, "ana-regybox");
  assert.equal(updatedConfig.vars, undefined);
});

test("central updates record the installed commit without changing deployment mode", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-updater-marker-"));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(source, "wrangler.jsonc"), upstreamConfig);
  writeFileSync(join(target, "wrangler.jsonc"), deploymentConfig);
  writeFileSync(
    join(source, ".regybox-deployment.json"),
    JSON.stringify({
      schemaVersion: 1,
      upstream: "martimlobao/regybox",
      channel: "main",
      mode: "auto",
      installedCommit: "",
    }),
  );
  writeFileSync(
    join(target, ".regybox-deployment.json"),
    JSON.stringify({
      schemaVersion: 1,
      upstream: "martimlobao/regybox",
      channel: "main",
      mode: "paused",
      installedCommit: "old",
    }),
  );

  updateFromUpstream({
    sourceDirectory: source,
    targetDirectory: target,
    installedCommit: "abc123",
  });

  const marker = JSON.parse(readFileSync(join(target, ".regybox-deployment.json"), "utf8"));
  assert.equal(marker.installedCommit, "abc123");
  assert.equal(marker.mode, "paused");
  const manifest = JSON.parse(readFileSync(join(target, ".regybox-updater-files.json"), "utf8"));
  assert.equal(manifest.files.includes(".regybox-deployment.json"), false);
});

test("the synchronous update walk observes the shared repository deadline", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-updater-deadline-"));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(target, "src"), { recursive: true });
  writeFileSync(join(source, "wrangler.jsonc"), upstreamConfig);
  writeFileSync(join(source, "src", "worker.js"), "new bytes\n");
  writeFileSync(join(target, "wrangler.jsonc"), deploymentConfig);
  writeFileSync(join(target, "src", "worker.js"), "old bytes\n");
  let checks = 0;

  assert.throws(
    () =>
      updateFromUpstream({
        sourceDirectory: source,
        targetDirectory: target,
        checkDeadline: () => {
          checks += 1;
          if (checks === 2) {
            throw new Error("repository deadline exceeded");
          }
        },
      }),
    /repository deadline exceeded/,
  );
  assert.equal(readFileSync(join(target, "src", "worker.js"), "utf8"), "old bytes\n");
});

test("automatic updates reject POSIX and Windows absolute paths from old manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-updater-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const outside = join(root, "do-not-delete.txt");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(source, "wrangler.jsonc"), upstreamConfig);
  writeFileSync(join(target, "wrangler.jsonc"), deploymentConfig);
  writeFileSync(outside, "keep me\n");
  const windowsPaths = [
    "C:\\absolute.txt",
    "C:drive-relative.txt",
    "\\root-relative.txt",
    "\\\\server\\share.txt",
  ];
  for (const path of windowsPaths) {
    writeFileSync(join(target, path), `keep ${path}\n`);
  }
  writeFileSync(
    join(target, ".regybox-updater-files.json"),
    JSON.stringify({
      files: [
        "../../do-not-delete.txt",
        outside,
        "/root",
        ...windowsPaths,
      ],
    }),
  );

  updateFromUpstream({ sourceDirectory: source, targetDirectory: target });

  assert.equal(readFileSync(outside, "utf8"), "keep me\n");
  for (const path of windowsPaths) {
    assert.equal(readFileSync(join(target, path), "utf8"), `keep ${path}\n`);
  }
});

test("automatic updates reject a symlinked managed file without changing external bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-updater-symlink-file-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const external = join(root, "external-worker.js");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(target, "src"), { recursive: true });
  writeFileSync(join(source, "wrangler.jsonc"), upstreamConfig);
  writeFileSync(join(source, "src", "worker.js"), "trusted source\n");
  writeFileSync(join(target, "wrangler.jsonc"), deploymentConfig);
  writeFileSync(external, "external bytes\n");
  symlinkSync(external, join(target, "src", "worker.js"));

  assert.throws(
    () => updateFromUpstream({ sourceDirectory: source, targetDirectory: target }),
    /tree containing a symlink/,
  );
  assert.equal(readFileSync(external, "utf8"), "external bytes\n");
  assert.equal(readFileSync(join(source, "src", "worker.js"), "utf8"), "trusted source\n");
});

test("automatic updates reject a symlinked manifest parent without deleting external bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-updater-symlink-parent-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const externalDirectory = join(root, "external");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  mkdirSync(externalDirectory, { recursive: true });
  writeFileSync(join(source, "wrangler.jsonc"), upstreamConfig);
  writeFileSync(join(target, "wrangler.jsonc"), deploymentConfig);
  writeFileSync(join(externalDirectory, "obsolete.js"), "do not delete\n");
  symlinkSync(externalDirectory, join(target, "managed"));
  writeFileSync(
    join(target, ".regybox-updater-files.json"),
    JSON.stringify({ files: ["managed/obsolete.js"] }),
  );

  assert.throws(
    () => updateFromUpstream({ sourceDirectory: source, targetDirectory: target }),
    /tree containing a symlink/,
  );
  assert.equal(readFileSync(join(externalDirectory, "obsolete.js"), "utf8"), "do not delete\n");
  assert.equal(readFileSync(join(source, "wrangler.jsonc"), "utf8"), upstreamConfig);
});
