import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_FILE = ".wrangler.deploy.jsonc";

export const WORKER_VAR_KEYS = [
  "BOOKING_PLATFORM",
  "CLASS_MAP",
  "CALENDAR_EVENT_NAMES",
  "CLASS_TYPE",
  "EMAIL_PROVIDER",
  "GITHUB_OWNER",
  "GITHUB_REF",
  "GITHUB_REPO",
  "GITHUB_WORKFLOW",
  "LOOKAHEAD_HOURS",
  "TIMEZONE",
];

export function loadRepoDotEnv(repoRoot, filename = ".env") {
  const envPath = resolve(repoRoot, filename);
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    // Local env files are optional when deploy variables are already exported.
  }
}

export function stripJsoncComments(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
        result += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && nextCharacter === "/") {
        inBlockComment = false;
        index += 1;
      } else if (character === "\n") {
        result += character;
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && nextCharacter === "/") {
      inLineComment = true;
      index += 1;
    } else if (character === "/" && nextCharacter === "*") {
      inBlockComment = true;
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

export function collectWorkerVars(env) {
  const vars = {};
  for (const key of WORKER_VAR_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      vars[key] = value;
    }
  }
  return vars;
}

export function renderWranglerConfig(templateText, namespaceId, env = {}) {
  const id = namespaceId?.trim();
  if (!id) {
    throw new Error("CF_KV_NAMESPACE_ID is required to deploy the scheduler worker.");
  }
  const config = JSON.parse(stripJsoncComments(templateText));
  const namespace = config.kv_namespaces?.[0];
  if (
    !namespace ||
    namespace.binding !== "REGYBOX_STATE" ||
    Object.hasOwn(namespace, "id")
  ) {
    throw new Error("wrangler.jsonc must include an unpinned REGYBOX_STATE KV binding.");
  }
  namespace.id = id;
  const nativeEmail = env.EMAIL_PROVIDER?.trim().toLowerCase() === "cloudflare";
  if (nativeEmail) {
    const sender = env.EMAIL_FROM?.trim();
    const recipient = env.EMAIL_TO?.trim();
    if (!sender || !recipient) {
      throw new Error("EMAIL_FROM and EMAIL_TO are required for Cloudflare email deployment.");
    }
    // Restrict native sending to the configured sender and verified recipient.
    config.send_email = [
      ...(config.send_email ?? []).filter((binding) => binding.name !== "EMAIL_SENDER"),
      {
        name: "EMAIL_SENDER",
        allowed_sender_addresses: [sender],
        allowed_destination_addresses: [recipient],
      },
    ];
  }
  const vars = collectWorkerVars(env);
  if (nativeEmail) {
    vars.EMAIL_PROVIDER = "cloudflare";
    vars.EMAIL_FROM = env.EMAIL_FROM.trim();
    vars.EMAIL_TO = env.EMAIL_TO.trim();
  }
  if (Object.keys(vars).length > 0) {
    config.vars = vars;
  } else {
    delete config.vars;
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function requiredProductionValue(reference, env) {
  if (typeof reference !== "string" || !/^REGYBOX_PRODUCTION_[A-Z0-9_]+$/.test(reference)) {
    throw new Error("Production profile must use REGYBOX_PRODUCTION_* environment references.");
  }
  const value = env[reference]?.trim();
  if (!value) {
    throw new Error(`Missing ${reference} for production deployment.`);
  }
  return value;
}

export function renderProductionWranglerConfig(templateText, profileText, env = {}) {
  const profile = JSON.parse(profileText);
  if (profile.email?.provider !== "cloudflare") {
    throw new Error("Production profile requires Cloudflare native email.");
  }
  const accountId = requiredProductionValue(profile.accountIdEnv, env);
  const id = requiredProductionValue(profile.kvNamespaceIdEnv, env);
  const sender = requiredProductionValue(profile.email.fromEnv, env);
  const recipient = requiredProductionValue(profile.email.toEnv, env);
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "")) {
    throw new Error("Production profile requires a valid Cloudflare account ID.");
  }
  if (!/^[a-f0-9]{32}$/.test(id ?? "")) {
    throw new Error("Production profile requires a valid REGYBOX_STATE KV namespace ID.");
  }
  if (env.CF_KV_NAMESPACE_ID?.trim() && env.CF_KV_NAMESPACE_ID.trim() !== id) {
    throw new Error("CF_KV_NAMESPACE_ID disagrees with the tracked production KV namespace.");
  }
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"]) {
    if (env[key]?.trim() && env[key].trim() !== accountId) {
      throw new Error(`${key} disagrees with the tracked production Cloudflare account.`);
    }
  }
  // Ignore legacy email variables, including stale SMTP settings. The tracked
  // profile selects native email and resolves its addresses from private inputs.
  const config = JSON.parse(renderWranglerConfig(templateText, id, {
    EMAIL_PROVIDER: profile.email.provider,
    EMAIL_FROM: sender,
    EMAIL_TO: recipient,
  }));
  config.account_id = accountId;
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function renderDeploymentConfig(templateText, { profileText, mode = "default", env = {} } = {}) {
  if (mode === "manual") {
    return renderWranglerConfig(templateText, env.CF_KV_NAMESPACE_ID, env);
  }
  if (mode === "production" || (mode === "default" && profileText !== undefined)) {
    if (profileText === undefined) {
      throw new Error("The tracked production Worker profile is missing.");
    }
    return renderProductionWranglerConfig(templateText, profileText, env);
  }
  if (mode === "default") {
    // The one-click copy has no owner profile; preserve its generic template.
    return templateText;
  }
  throw new Error("Choose default, manual, or production deployment.");
}

function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(packageRoot, "../..");
  const requested = process.argv.slice(2);
  if (requested.length > 1 || (requested[0] && !["--manual", "--production"].includes(requested[0]))) {
    throw new Error("Choose one deployment mode: --manual or --production.");
  }
  const mode = requested[0]?.slice(2) ?? "default";
  const profilePath = resolve(repoRoot, "deploy/production-worker.json");
  // A copied one-click Worker lives outside the source repository layout.
  const sourceLayout = resolve(repoRoot, "cloudflare/regybox-scheduler") === packageRoot;
  const hasProfile = sourceLayout && existsSync(profilePath);
  if (!hasProfile && (mode === "production" || (mode === "default" && sourceLayout))) {
    throw new Error("The tracked production Worker profile is missing.");
  }
  if (mode === "manual") {
    loadRepoDotEnv(repoRoot);
  } else if (hasProfile) {
    loadRepoDotEnv(repoRoot, ".env.production");
  }
  const templatePath = resolve(packageRoot, "wrangler.jsonc");
  const outputPath = resolve(packageRoot, OUTPUT_FILE);
  const rendered = renderDeploymentConfig(
    readFileSync(templatePath, "utf8"),
    {
      profileText: mode !== "manual" && hasProfile ? readFileSync(profilePath, "utf8") : undefined,
      mode,
      env: process.env,
    },
  );
  writeFileSync(outputPath, rendered);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
