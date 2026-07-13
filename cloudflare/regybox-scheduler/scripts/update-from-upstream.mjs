import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stripJsoncComments } from "./render-wrangler-config.mjs";

const MANIFEST_FILE = ".regybox-updater-files.json";
const PRESERVED_PATHS = new Set([".dev.vars", ".env", ".git", ".wrangler", "node_modules"]);

function parseConfig(text) {
  return JSON.parse(stripJsoncComments(text));
}

function preserveKvNamespaceIds(upstreamNamespaces = [], deploymentNamespaces = []) {
  const deploymentByBinding = new Map(
    deploymentNamespaces.map((namespace) => [namespace.binding, namespace]),
  );
  return upstreamNamespaces.map((namespace) => {
    const deployed = deploymentByBinding.get(namespace.binding);
    if (!deployed?.id) {
      return namespace;
    }
    return { ...namespace, id: deployed.id };
  });
}

export function mergeDeploymentConfig({ deploymentText, upstreamText }) {
  const deployment = parseConfig(deploymentText);
  const upstream = parseConfig(upstreamText);
  const merged = {
    ...upstream,
    keep_vars: true,
  };

  if (deployment.name) {
    merged.name = deployment.name;
  }
  if (Array.isArray(upstream.kv_namespaces) && upstream.kv_namespaces.length > 0) {
    merged.kv_namespaces = preserveKvNamespaceIds(
      upstream.kv_namespaces,
      deployment.kv_namespaces,
    );
  } else if (Array.isArray(deployment.kv_namespaces)) {
    merged.kv_namespaces = deployment.kv_namespaces;
  }

  // Variables and secrets belong to the user's Cloudflare dashboard. Keeping
  // them out of future deployments prevents an upstream update from replacing
  // CLASS_MAP, cookies, calendar URL, or any optional notification setting.
  delete merged.vars;
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function listManagedFiles(sourceDirectory, currentDirectory = sourceDirectory, files = []) {
  for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
    const sourcePath = resolve(currentDirectory, entry.name);
    const sourceRelativePath = relative(sourceDirectory, sourcePath);
    if (PRESERVED_PATHS.has(sourceRelativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      listManagedFiles(sourceDirectory, sourcePath, files);
    } else if (entry.isFile()) {
      files.push(sourceRelativePath);
    }
  }
  return files.sort();
}

function readPreviousManifest(targetDirectory) {
  const manifestPath = resolve(targetDirectory, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return [];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Array.isArray(manifest.files) ? manifest.files.filter(isSafeRelativePath) : [];
}

function isSafeRelativePath(file) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    !file.startsWith("/") &&
    !file.split(/[\\/]/).includes("..")
  );
}

function copyFile(sourceDirectory, targetDirectory, file) {
  const sourcePath = resolve(sourceDirectory, file);
  const targetPath = resolve(targetDirectory, file);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath));
}

export function updateFromUpstream({ sourceDirectory, targetDirectory }) {
  const source = resolve(sourceDirectory);
  const target = resolve(targetDirectory);
  if (!statSync(source).isDirectory() || !statSync(target).isDirectory()) {
    throw new Error("Source and target must both be directories.");
  }

  const existingConfigPath = resolve(target, "wrangler.jsonc");
  const upstreamConfigPath = resolve(source, "wrangler.jsonc");
  const deploymentText = readFileSync(existingConfigPath, "utf8");
  const upstreamText = readFileSync(upstreamConfigPath, "utf8");
  const files = listManagedFiles(source);
  const previousFiles = readPreviousManifest(target);

  for (const file of previousFiles) {
    if (!files.includes(file)) {
      rmSync(resolve(target, file), { force: true });
    }
  }
  for (const file of files) {
    copyFile(source, target, file);
  }

  writeFileSync(
    existingConfigPath,
    mergeDeploymentConfig({ deploymentText, upstreamText }),
  );
  writeFileSync(
    resolve(target, MANIFEST_FILE),
    `${JSON.stringify({ files }, null, 2)}\n`,
  );
}

function main() {
  const [sourceDirectory, targetDirectory = "."] = process.argv.slice(2);
  if (!sourceDirectory) {
    throw new Error("Usage: update-from-upstream.mjs <source-directory> [target-directory]");
  }
  updateFromUpstream({ sourceDirectory, targetDirectory });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
