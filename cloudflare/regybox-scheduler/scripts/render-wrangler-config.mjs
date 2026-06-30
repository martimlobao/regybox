import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "replace-with-your-kv-namespace-id";
const OUTPUT_FILE = ".wrangler.deploy.jsonc";

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

export function renderWranglerConfig(templateText, namespaceId) {
  const id = namespaceId?.trim();
  if (!id) {
    throw new Error("CF_KV_NAMESPACE_ID is required to deploy the scheduler worker.");
  }
  if (!templateText.includes(PLACEHOLDER)) {
    throw new Error(`wrangler.jsonc is missing placeholder ${PLACEHOLDER}.`);
  }
  return templateText.replace(PLACEHOLDER, id);
}

function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(packageRoot, "../..");
  if (!process.env.CF_KV_NAMESPACE_ID?.trim()) {
    loadRepoDotEnv(repoRoot);
  }
  const templatePath = resolve(packageRoot, "wrangler.jsonc");
  const outputPath = resolve(packageRoot, OUTPUT_FILE);
  const rendered = renderWranglerConfig(
    readFileSync(templatePath, "utf8"),
    process.env.CF_KV_NAMESPACE_ID,
  );
  writeFileSync(outputPath, rendered);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
