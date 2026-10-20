import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  collectWorkerVars,
  loadRepoDotEnv,
  renderDeploymentConfig,
  renderWranglerConfig,
  renderProductionWranglerConfig,
  stripJsoncComments,
} from "../scripts/render-wrangler-config.mjs";

const template = `{
  "keep_vars": true,
  "vars": {
    "BOOKING_PLATFORM": "regybox",
    "CLASS_MAP": "CrossFit = WOD",
    "TIMEZONE": "Europe/Lisbon",
    "LOOKAHEAD_HOURS": "73"
  },
  "kv_namespaces": [
    { "binding": "REGYBOX_STATE" }
  ]
}`;

const productionProfile = JSON.stringify({
  accountIdEnv: "REGYBOX_PRODUCTION_ACCOUNT_ID",
  kvNamespaceIdEnv: "REGYBOX_PRODUCTION_KV_NAMESPACE_ID",
  email: {
    provider: "cloudflare",
    fromEnv: "REGYBOX_PRODUCTION_EMAIL_FROM",
    toEnv: "REGYBOX_PRODUCTION_EMAIL_TO",
  },
});
const productionEnv = {
  REGYBOX_PRODUCTION_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  REGYBOX_PRODUCTION_KV_NAMESPACE_ID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  REGYBOX_PRODUCTION_EMAIL_FROM: "bookings@example.test",
  REGYBOX_PRODUCTION_EMAIL_TO: "owner@example.test",
};

test("renderWranglerConfig strips deploy-button defaults for manual deploys", () => {
  const rendered = JSON.parse(renderWranglerConfig(template, "test-kv-namespace-id"));
  assert.equal(rendered.kv_namespaces[0].id, "test-kv-namespace-id");
  assert.equal(rendered.vars, undefined);
  assert.equal(rendered.send_email, undefined);
});

test("native email deploy restricts the binding and keeps SMTP credentials out of vars", () => {
  const rendered = JSON.parse(renderWranglerConfig(template, "namespace-id", {
    EMAIL_PROVIDER: "cloudflare",
    EMAIL_FROM: " bookings@example.test ",
    EMAIL_TO: " owner@example.test ",
    EMAIL_PASSWORD: "must-not-be-deployed-as-text",
  }));
  assert.deepEqual(rendered.send_email, [{
    name: "EMAIL_SENDER",
    allowed_sender_addresses: ["bookings@example.test"],
    allowed_destination_addresses: ["owner@example.test"],
  }]);
  assert.deepEqual(rendered.vars, {
    EMAIL_PROVIDER: "cloudflare",
    EMAIL_FROM: "bookings@example.test",
    EMAIL_TO: "owner@example.test",
  });
});

test("native email deploy refuses missing sender or recipient", () => {
  for (const values of [{}, { EMAIL_FROM: "bookings@example.test" }, { EMAIL_TO: "owner@example.test" }]) {
    assert.throws(() => renderWranglerConfig(template, "namespace-id", {
      EMAIL_PROVIDER: "cloudflare", ...values,
    }), /EMAIL_FROM and EMAIL_TO are required/);
  }
});

test("manual SMTP deploy leaves email addresses in existing Worker secrets", () => {
  for (const provider of [undefined, "smtp"]) {
    const rendered = JSON.parse(renderWranglerConfig(template, "namespace-id", {
      EMAIL_PROVIDER: provider,
      EMAIL_FROM: "sender@example.test",
      EMAIL_TO: "owner@example.test",
      EMAIL_USERNAME: "sender@example.test",
      EMAIL_PASSWORD: "private-password",
      GITHUB_OWNER: "example-owner",
    }));
    assert.equal(rendered.vars.GITHUB_OWNER, "example-owner");
    assert.equal(rendered.vars.EMAIL_FROM, undefined);
    assert.equal(rendered.vars.EMAIL_TO, undefined);
    assert.equal(rendered.vars.EMAIL_PASSWORD, undefined);
    assert.equal(rendered.send_email, undefined);
  }
});

test("tracked production profile wins over stale local email settings and keeps Worker bindings", () => {
  const packageRoot = resolve(fileURLToPath(import.meta.url), "../..");
  const fullTemplate = readFileSync(resolve(packageRoot, "wrangler.jsonc"), "utf8");
  const rendered = JSON.parse(renderDeploymentConfig(fullTemplate, { profileText: productionProfile, env: {
    ...productionEnv,
    EMAIL_PROVIDER: "smtp",
    EMAIL_FROM: "wrong@example.test",
    EMAIL_TO: "wrong@example.test",
    EMAIL_USERNAME: "old-gmail@example.test",
    EMAIL_PASSWORD: "old-password",
  } }));
  assert.deepEqual(rendered.vars, {
    EMAIL_PROVIDER: "cloudflare",
    EMAIL_FROM: "bookings@example.test",
    EMAIL_TO: "owner@example.test",
  });
  assert.deepEqual(rendered.send_email, [{
    name: "EMAIL_SENDER",
    allowed_sender_addresses: ["bookings@example.test"],
    allowed_destination_addresses: ["owner@example.test"],
  }]);
  assert.equal(rendered.kv_namespaces[0].id, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(rendered.account_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.deepEqual(rendered.durable_objects, {
    bindings: [{ name: "BOOKR_COORDINATOR", class_name: "BookrCoordinator" }],
  });
  assert.equal(rendered.keep_vars, true);
});

test("production deployment rejects a conflicting KV ID before writing or deploying", () => {
  for (const key of Object.keys(productionEnv)) {
    const missing = { ...productionEnv };
    delete missing[key];
    assert.throws(() => renderProductionWranglerConfig(template, productionProfile, missing),
      new RegExp(`Missing ${key}`));
  }
  assert.throws(() => renderProductionWranglerConfig(template, productionProfile, {
    ...productionEnv,
    CF_KV_NAMESPACE_ID: "cccccccccccccccccccccccccccccccc",
  }), /disagrees with the tracked production KV namespace/);
  assert.throws(() => renderProductionWranglerConfig(template, productionProfile, {
    ...productionEnv,
    CLOUDFLARE_ACCOUNT_ID: "dddddddddddddddddddddddddddddddd",
  }), /disagrees with the tracked production Cloudflare account/);
  assert.throws(() => renderProductionWranglerConfig(template, JSON.stringify({
    ...JSON.parse(productionProfile), accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
  }), productionEnv), /REGYBOX_PRODUCTION_\*/);
});

test("renderer keeps copied templates generic and honors explicit manual mode", () => {
  assert.equal(renderDeploymentConfig(template), template);
  const manual = JSON.parse(renderDeploymentConfig(template, {
    profileText: productionProfile,
    mode: "manual",
    env: { CF_KV_NAMESPACE_ID: "manual-namespace", EMAIL_PROVIDER: "smtp" },
  }));
  assert.equal(manual.kv_namespaces[0].id, "manual-namespace");
  assert.equal(manual.vars.EMAIL_PROVIDER, "smtp");
  assert.equal(manual.send_email, undefined);
  assert.throws(() => renderDeploymentConfig(template, { mode: "production", env: productionEnv }),
    /profile is missing/);
  const scriptPath = resolve(fileURLToPath(import.meta.url), "../../scripts/render-wrangler-config.mjs");
  const both = spawnSync(process.execPath, [scriptPath, "--manual", "--production"], {
    encoding: "utf8",
  });
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /Choose one deployment mode/);
});

test("copied Worker stays generic while the source checkout requires its profile", () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-copied-worker-"));
  const worker = join(root, "other", "worker");
  const script = join(worker, "scripts", "render-wrangler-config.mjs");
  try {
    mkdirSync(join(worker, "scripts"), { recursive: true });
    mkdirSync(join(root, "deploy"));
    writeFileSync(join(root, "deploy", "production-worker.json"), productionProfile);
    writeFileSync(join(worker, "wrangler.jsonc"), template);
    writeFileSync(script, readFileSync(new URL("../scripts/render-wrangler-config.mjs", import.meta.url)));
    const result = spawnSync(process.execPath, [realpathSync(script)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(worker, ".wrangler.deploy.jsonc"), "utf8"), template);

    rmSync(join(root, "deploy", "production-worker.json"));
    const sourceWorker = join(root, "cloudflare", "regybox-scheduler");
    const sourceScript = join(sourceWorker, "scripts", "render-wrangler-config.mjs");
    mkdirSync(join(sourceWorker, "scripts"), { recursive: true });
    writeFileSync(sourceScript, readFileSync(new URL("../scripts/render-wrangler-config.mjs", import.meta.url)));
    const missing = spawnSync(process.execPath, [realpathSync(sourceScript)], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /tracked production Worker profile is missing/);
    assert.equal(existsSync(join(sourceWorker, ".wrangler.deploy.jsonc")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stripJsoncComments preserves comment markers inside strings", () => {
  const parsed = JSON.parse(
    stripJsoncComments(`{
      // deployment metadata
      "$schema": "https://example.test/wrangler.schema.json",
      "escaped": "quote: \\\" // still a string",
      "status": "https://worker.example.test/regybox" /* configured route */
    }`),
  );

  assert.equal(parsed.$schema, "https://example.test/wrangler.schema.json");
  assert.equal(parsed.escaped, 'quote: " // still a string');
  assert.equal(parsed.status, "https://worker.example.test/regybox");
});

test("renderWranglerConfig injects worker vars from env", () => {
  const rendered = JSON.parse(
    renderWranglerConfig(template, "test-kv-namespace-id", {
      GITHUB_OWNER: "example-owner",
      BOOKING_PLATFORM: "bookr",
      CLASS_MAP: "CrossFit = WOD",
    }),
  );
  assert.deepEqual(rendered.vars, {
      GITHUB_OWNER: "example-owner",
      BOOKING_PLATFORM: "bookr",
      CLASS_MAP: "CrossFit = WOD",
  });
});

test("collectWorkerVars ignores empty values", () => {
  assert.deepEqual(
    collectWorkerVars({
      GITHUB_OWNER: " example-owner ",
      GITHUB_REPO: "   ",
      BOOKING_PLATFORM: "  bookr  ",
      LOOKAHEAD_HOURS: "73",
    }),
    {
      GITHUB_OWNER: "example-owner",
      BOOKING_PLATFORM: "bookr",
      LOOKAHEAD_HOURS: "73",
    },
  );
});

test("Bookr authentication cookies are never deploy-time text variables", () => {
  assert.deepEqual(
    collectWorkerVars({
      BOOKR_AUTH_COOKIE: "sb-jphimrpybgssduyuziaw-auth-token=secret",
    }),
    {},
  );
});

test("renderWranglerConfig rejects a missing namespace id", () => {
  assert.throws(
    () => renderWranglerConfig(template, ""),
    /CF_KV_NAMESPACE_ID is required/,
  );
});

test("renderWranglerConfig rejects a template with a pinned namespace", () => {
  assert.throws(
    () =>
      renderWranglerConfig(
        template.replace('"binding": "REGYBOX_STATE"', '"binding": "REGYBOX_STATE", "id": "old-id"'),
        "test-kv-namespace-id",
      ),
    /unpinned REGYBOX_STATE KV binding/,
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

test("loadRepoDotEnv accepts a private production filename and surfaces read errors", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "regybox-production-env-"));
  const key = "TEST_REGYBOX_DEPLOY_INPUT";
  const previous = process.env[key];
  delete process.env[key];
  try {
    loadRepoDotEnv(repoRoot, ".env.production");
    writeFileSync(join(repoRoot, ".env.production"), `${key}=example-value\n`);
    loadRepoDotEnv(repoRoot, ".env.production");
    assert.equal(process.env[key], "example-value");
    mkdirSync(join(repoRoot, "unreadable.env"));
    assert.throws(() => loadRepoDotEnv(repoRoot, "unreadable.env"));
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});
