import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stripJsoncComments } from "./render-wrangler-config.mjs";

const MANIFEST_FILE = ".regybox-updater-files.json";
const DEPLOYMENT_MARKER_FILE = ".regybox-deployment.json";
const PRESERVED_DIRECTORIES = new Set([".git", ".github", ".wrangler", "node_modules"]);

function assertNoSymlinks(
  rootDirectory,
  {
    allowGitDirectory = false,
    skipPreservedDirectories = false,
    checkDeadline = () => {},
  } = {},
) {
  const pending = [resolve(rootDirectory)];
  while (pending.length > 0) {
    checkDeadline();
    const current = pending.pop();
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const path = relative(rootDirectory, current) || ".";
      throw new Error(`Refusing to update a tree containing a symlink: ${path}`);
    }
    if (!stat.isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      checkDeadline();
      const path = resolve(current, entry.name);
      const relativePath = relative(rootDirectory, path);
      if (
        skipPreservedDirectories &&
        !relativePath.includes("/") &&
        PRESERVED_DIRECTORIES.has(relativePath)
      ) {
        continue;
      }
      if (allowGitDirectory && relativePath === ".git") {
        const gitStat = lstatSync(path);
        if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
          throw new Error("Refusing to update a tree without a real .git directory");
        }
        continue;
      }
      pending.push(path);
    }
  }
}

function isPreservedPath(file) {
  const parts = String(file).split(/[\\/]/);
  const root = parts[0];
  return (
    PRESERVED_DIRECTORIES.has(root) ||
    root === DEPLOYMENT_MARKER_FILE ||
    root === ".env" ||
    root.startsWith(".env.") ||
    root === ".dev.vars" ||
    root.startsWith(".dev.vars.")
  );
}

function parseConfig(text) {
  return JSON.parse(stripJsoncComments(text));
}

function preserveKvNamespaceIds(upstreamNamespaces = [], deploymentNamespaces = []) {
  const deploymentByBinding = new Map(
    deploymentNamespaces.map((namespace) => [namespace.binding, namespace]),
  );
  const merged = upstreamNamespaces.map((namespace) => {
    const deployed = deploymentByBinding.get(namespace.binding);
    if (!deployed?.id) {
      return namespace;
    }
    return { ...namespace, id: deployed.id };
  });
  const upstreamBindings = new Set(upstreamNamespaces.map((namespace) => namespace.binding));
  return merged.concat(
    deploymentNamespaces.filter((namespace) => !upstreamBindings.has(namespace.binding)),
  );
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

function listManagedFiles(
  sourceDirectory,
  currentDirectory = sourceDirectory,
  files = [],
  checkDeadline = () => {},
) {
  for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
    checkDeadline();
    const sourcePath = resolve(currentDirectory, entry.name);
    const sourceRelativePath = relative(sourceDirectory, sourcePath);
    if (isPreservedPath(sourceRelativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      listManagedFiles(sourceDirectory, sourcePath, files, checkDeadline);
    } else if (entry.isFile()) {
      files.push(sourceRelativePath);
    }
  }
  return files.sort();
}

function readPreviousManifest(targetDirectory, checkDeadline = () => {}) {
  checkDeadline();
  const manifestPath = resolve(targetDirectory, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return [];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Array.isArray(manifest.files)
    ? manifest.files.filter((file) => isSafeRelativePath(file) && !isPreservedPath(file))
    : [];
}

function isSafeRelativePath(file) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    !/^[/\\]/.test(file) &&
    !/^[A-Za-z]:/.test(file) &&
    !file.split(/[\\/]/).includes("..")
  );
}

function copyFile(sourceDirectory, targetDirectory, file, checkDeadline = () => {}) {
  checkDeadline();
  const sourcePath = resolve(sourceDirectory, file);
  const targetPath = resolve(targetDirectory, file);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath));
  checkDeadline();
}

function updateDeploymentMarker({ source, target, installedCommit, checkDeadline = () => {} }) {
  checkDeadline();
  const upstreamPath = resolve(source, DEPLOYMENT_MARKER_FILE);
  if (!existsSync(upstreamPath)) {
    return;
  }
  const targetPath = resolve(target, DEPLOYMENT_MARKER_FILE);
  const upstream = JSON.parse(readFileSync(upstreamPath, "utf8"));
  const deployment = existsSync(targetPath)
    ? JSON.parse(readFileSync(targetPath, "utf8"))
    : {};
  const marker = {
    ...upstream,
    mode: deployment.mode ?? upstream.mode,
    installedCommit:
      installedCommit ?? deployment.installedCommit ?? upstream.installedCommit,
  };
  writeFileSync(targetPath, `${JSON.stringify(marker, null, 2)}\n`);
  checkDeadline();
}

export function updateFromUpstream({
  sourceDirectory,
  targetDirectory,
  installedCommit,
  checkDeadline = () => {},
}) {
  checkDeadline();
  const source = resolve(sourceDirectory);
  const target = resolve(targetDirectory);
  if (!lstatSync(source).isDirectory() || !lstatSync(target).isDirectory()) {
    throw new Error("Source and target must both be directories.");
  }
  // Deployment repositories are untrusted input. Reject links before reading
  // config/marker/manifest files or applying any copy/delete operation so a
  // repository cannot redirect updater access outside its worktree.
  assertNoSymlinks(source, {
    allowGitDirectory: true,
    skipPreservedDirectories: true,
    checkDeadline,
  });
  assertNoSymlinks(target, { allowGitDirectory: true, checkDeadline });

  checkDeadline();
  const existingConfigPath = resolve(target, "wrangler.jsonc");
  const upstreamConfigPath = resolve(source, "wrangler.jsonc");
  const deploymentText = readFileSync(existingConfigPath, "utf8");
  const upstreamText = readFileSync(upstreamConfigPath, "utf8");
  const files = listManagedFiles(source, source, [], checkDeadline);
  const previousFiles = readPreviousManifest(target, checkDeadline);

  for (const file of previousFiles) {
    checkDeadline();
    if (!files.includes(file)) {
      rmSync(resolve(target, file), { force: true });
    }
  }
  for (const file of files) {
    copyFile(source, target, file, checkDeadline);
  }

  checkDeadline();
  writeFileSync(
    existingConfigPath,
    mergeDeploymentConfig({ deploymentText, upstreamText }),
  );
  writeFileSync(
    resolve(target, MANIFEST_FILE),
    `${JSON.stringify({ files }, null, 2)}\n`,
  );
  updateDeploymentMarker({ source, target, installedCommit, checkDeadline });
  checkDeadline();
}

function main() {
  const [sourceDirectory, targetDirectory = ".", installedCommit] = process.argv.slice(2);
  if (!sourceDirectory) {
    throw new Error("Usage: update-from-upstream.mjs <source-directory> [target-directory]");
  }
  updateFromUpstream({ sourceDirectory, targetDirectory, installedCommit });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
