import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "replace-with-your-kv-namespace-id";
const OUTPUT_FILE = ".wrangler.deploy.jsonc";

export const WORKER_VAR_KEYS = [
  "CALENDAR_EVENT_NAMES",
  "CLASS_TYPE",
  "GITHUB_OWNER",
  "GITHUB_REF",
  "GITHUB_REPO",
  "GITHUB_WORKFLOW",
  "LOOKAHEAD_HOURS",
  "TIMEZONE",
];

export function loadRepoDotEnv(repoRoot) {
  const envPath = resolve(repoRoot, ".env");
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
  } catch {
    // .env is optional when deploy variables are already exported
  }
}

export function stripJsoncComments(text) {
  return text.replace(/\/\/.*$/gm, "");
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
  if (!namespace || namespace.id !== PLACEHOLDER) {
    throw new Error(`wrangler.jsonc is missing placeholder ${PLACEHOLDER}.`);
  }
  namespace.id = id;
  const vars = collectWorkerVars(env);
  if (Object.keys(vars).length > 0) {
    config.vars = vars;
  } else {
    delete config.vars;
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(packageRoot, "../..");
  loadRepoDotEnv(repoRoot);
  const templatePath = resolve(packageRoot, "wrangler.jsonc");
  const outputPath = resolve(packageRoot, OUTPUT_FILE);
  const rendered = renderWranglerConfig(
    readFileSync(templatePath, "utf8"),
    process.env.CF_KV_NAMESPACE_ID,
    process.env,
  );
  writeFileSync(outputPath, rendered);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
