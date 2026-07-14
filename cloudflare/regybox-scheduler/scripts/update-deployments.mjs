import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";
import { spawnSync } from "node:child_process";

import { updateFromUpstream } from "./update-from-upstream.mjs";

const API_ROOT = "https://api.github.com";
const EXPECTED_MARKER = {
  schemaVersion: 1,
  upstream: "martimlobao/regybox",
  channel: "main",
};
const MARKER_FILE = ".regybox-deployment.json";
const UPDATE_BRANCH = "regybox-updater/main";
const INSTALLATION_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const MAX_REPOSITORY_SIZE_KB = 250_000;
const MAX_REPOSITORIES_INSPECTED_PER_INSTALLATION = 20;
const MAX_ELIGIBLE_REPOSITORIES_PER_INSTALLATION = 10;
const MAX_REPOSITORIES_PER_RUN = 50;
const MAX_RUN_DURATION_MS = 20 * 60 * 1000;
const REPOSITORY_DEADLINE_MS = 45 * 1000;
const MAX_TRACKED_ENTRIES = 10_000;
const MAX_CHECKOUT_BYTES = 100 * 1024 * 1024;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const GITHUB_API_TIMEOUT_MS = 15 * 1000;
const SENSITIVE_ENVIRONMENT_KEY =
  /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|API_KEY|ACCESS_KEY|AUTH|COOKIE|SESSION)/i;

export class GitHubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createAppJwt({ appId, privateKey, now = () => Date.now() }) {
  if (!String(appId ?? "").trim() || !String(privateKey ?? "").trim()) {
    throw new Error("REGYBOX_UPDATER_APP_ID and REGYBOX_UPDATER_PRIVATE_KEY are required");
  }
  const issuedAt = Math.floor(now() / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: String(appId) }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const normalizedKey = String(privateKey).replace(/\\n/g, "\n");
  return `${unsigned}.${signer.sign(normalizedKey, "base64url")}`;
}

export function redact(value, secrets = []) {
  let text = String(value ?? "")
    .replace(/(authorization:\s*(?:bearer|token)\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/https:\/\/[^/@\s]+@github\.com/gi, "https://[redacted]@github.com");
  for (const secret of secrets) {
    if (secret) {
      text = text.split(String(secret)).join("[redacted]");
    }
  }
  return text;
}

function gitChildEnvironment(processEnvironment, explicitEnvironment) {
  const environment = {};
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (!SENSITIVE_ENVIRONMENT_KEY.test(key) && !key.startsWith("REGYBOX_UPDATER_")) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(explicitEnvironment)) {
    if (
      !SENSITIVE_ENVIRONMENT_KEY.test(key) ||
      key === "REGYBOX_INSTALLATION_TOKEN"
    ) {
      environment[key] = value;
    }
  }
  return environment;
}

export function createGitRunner({
  secrets = [],
  processEnvironment = process.env,
  spawnImpl = spawnSync,
  timeoutMs = GIT_TIMEOUT_MS,
  maxBuffer = GIT_MAX_BUFFER_BYTES,
} = {}) {
  return function git(args, { cwd, env = {}, deadlineAt, now = () => Date.now() } = {}) {
    const subcommand = (() => {
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "-c") {
          index += 1;
        } else {
          return args[index];
        }
      }
      return "command";
    })();
    const remainingMs = deadlineAt === undefined ? timeoutMs : deadlineAt - now();
    if (remainingMs <= 0) {
      throw new Error(`repository deadline exceeded before git ${subcommand}`);
    }
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
    const result = spawnImpl("git", args, {
      cwd,
      env: gitChildEnvironment(processEnvironment, env),
      encoding: "utf8",
      timeout: effectiveTimeoutMs,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error?.code === "ETIMEDOUT") {
      throw new Error(`git ${subcommand} timed out after ${effectiveTimeoutMs}ms`);
    }
    if (result.error?.code === "ENOBUFS") {
      throw new Error(`git ${subcommand} exceeded its ${maxBuffer}-byte output limit`);
    }
    if (result.error) {
      throw new Error(`git ${subcommand} could not start: ${redact(result.error.message, secrets)}`);
    }
    if (result.status !== 0) {
      const detail = redact(result.stderr || result.stdout || "unknown git error", secrets).trim();
      throw new Error(`git ${subcommand} failed: ${detail}`);
    }
    if (deadlineAt !== undefined && now() >= deadlineAt) {
      throw new Error(`repository deadline exceeded during git ${subcommand}`);
    }
    return String(result.stdout ?? "").trim();
  };
}

function apiUrl(path) {
  return String(path).startsWith("https://") ? String(path) : `${API_ROOT}${path}`;
}

export async function githubRequest({
  path,
  token,
  method = "GET",
  body,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(apiUrl(path), {
    method,
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "regybox-updater",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let message = `GitHub API ${method} failed with HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.message) {
        message += `: ${String(payload.message).slice(0, 300)}`;
      }
    } catch {
      // The status code is sufficient when GitHub does not return JSON.
    }
    throw new GitHubApiError(redact(message, [token]), response.status);
  }
  const data = response.status === 204 ? null : await response.json();
  return { data, headers: response.headers };
}

function linkForRelation(headers, relation) {
  const link = headers?.get?.("link") ?? "";
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2].split(/\s+/).includes(relation)) {
      return match[1];
    }
  }
  return null;
}

function pageNumber(url) {
  if (!url) {
    return null;
  }
  const page = Number(new URL(url).searchParams.get("page"));
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}

function boundedPageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("GitHub page size must be an integer from 1 to 100");
  }
  return pageSize;
}

function rotatingPage(epoch, pageCount) {
  return ((epoch % pageCount) + pageCount) % pageCount + 1;
}

function uniqueWindow(primary, wrap, limit, identity) {
  const window = [];
  const seen = new Set();
  for (const item of primary.concat(wrap)) {
    const key = identity(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    window.push(item);
    if (window.length >= limit) {
      break;
    }
  }
  return window;
}

function rotateWindow(items, offset) {
  if (items.length === 0) {
    return [];
  }
  const start = ((offset % items.length) + items.length) % items.length;
  return items.slice(start).concat(items.slice(0, start));
}

export async function listInstallations({
  appJwt,
  request = githubRequest,
  pageSize = MAX_REPOSITORIES_PER_RUN,
  rotationEpochDay = 0,
}) {
  const limit = boundedPageSize(pageSize);
  const first = await request({
    path: `/app/installations?per_page=${limit}&page=1`,
    token: appJwt,
  });
  if (!Array.isArray(first.data)) {
    throw new Error("GitHub installations response had an unexpected shape");
  }
  const lastPage = pageNumber(linkForRelation(first.headers, "last"));
  if (linkForRelation(first.headers, "next") && lastPage === null) {
    throw new Error("GitHub installations pagination omitted its last page");
  }
  const selectedPage = rotatingPage(rotationEpochDay, lastPage ?? 1);
  const selected =
    selectedPage === 1
      ? first
      : await request({
          path: `/app/installations?per_page=${limit}&page=${selectedPage}`,
          token: appJwt,
        });
  if (!Array.isArray(selected.data)) {
    throw new Error("GitHub installations response had an unexpected shape");
  }
  return uniqueWindow(selected.data, first.data, limit, (installation) => installation.id);
}

export async function listInstallationRepositories({
  token,
  request = githubRequest,
  pageSize = MAX_REPOSITORIES_INSPECTED_PER_INSTALLATION,
  rotationEpochDay = 0,
  withinPageStride = pageSize,
}) {
  const limit = boundedPageSize(pageSize);
  const first = await request({
    path: `/installation/repositories?per_page=${limit}&page=1`,
    token,
  });
  if (!Array.isArray(first.data?.repositories)) {
    throw new Error("GitHub installation repositories response had an unexpected shape");
  }
  const reportedTotal = first.data.total_count;
  const totalCount =
    reportedTotal === undefined ? first.data.repositories.length : Number(reportedTotal);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new Error("GitHub installation repository count was invalid");
  }
  const pageCount = Math.max(1, Math.ceil(totalCount / limit));
  const selectedPage = rotatingPage(rotationEpochDay, pageCount);
  const selected =
    selectedPage === 1
      ? first
      : await request({
          path: `/installation/repositories?per_page=${limit}&page=${selectedPage}`,
          token,
        });
  if (!Array.isArray(selected.data?.repositories)) {
    throw new Error("GitHub installation repositories response had an unexpected shape");
  }
  const window = uniqueWindow(
    selected.data.repositories,
    first.data.repositories,
    limit,
    (repository) => repository.id ?? repository.full_name,
  );
  const completedPageCycles = Math.floor(rotationEpochDay / pageCount);
  return rotateWindow(window, completedPageCycles * withinPageStride);
}

export async function createInstallationToken({ installationId, appJwt, request = githubRequest }) {
  const { data } = await request({
    path: `/app/installations/${installationId}/access_tokens`,
    token: appJwt,
    method: "POST",
  });
  const expiresAt = Date.parse(String(data?.expires_at ?? ""));
  if (!data?.token || !Number.isFinite(expiresAt)) {
    throw new Error(`Installation ${installationId} did not return valid token credentials`);
  }
  return { token: data.token, expiresAt };
}

export function validateMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return { eligible: false, reason: "missing marker" };
  }
  for (const [key, expected] of Object.entries(EXPECTED_MARKER)) {
    if (marker[key] !== expected) {
      return { eligible: false, reason: `marker ${key} does not match` };
    }
  }
  if (marker.mode !== "auto") {
    return { eligible: false, reason: "automatic updates disabled by marker" };
  }
  if (typeof marker.installedCommit !== "string") {
    return { eligible: false, reason: "marker installedCommit is invalid" };
  }
  return { eligible: true };
}

export async function readDeploymentMarker({ repo, token, request = githubRequest }) {
  const ref = encodeURIComponent(repo.default_branch || "main");
  try {
    const { data } = await request({
      path: `/repos/${repo.full_name}/contents/${MARKER_FILE}?ref=${ref}`,
      token,
    });
    if (data?.type !== "file" || data?.encoding !== "base64" || !data?.content) {
      return null;
    }
    try {
      return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    } catch {
      return null;
    }
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function assertRepositoryName(fullName) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(fullName))) {
    throw new Error("GitHub returned an invalid repository name");
  }
}

function writeAskpass(directory) {
  const path = join(directory, "git-askpass.sh");
  writeFileSync(
    path,
    "#!/bin/sh\n" +
      "case \"$1\" in\n" +
      "  \"Username for 'https://github.com':\"*) printf '%s\\n' x-access-token ;;\n" +
      "  \"Password for 'https://x-access-token@github.com':\"*) " +
      "printf '%s\\n' \"$REGYBOX_INSTALLATION_TOKEN\" ;;\n" +
      "  *) exit 1 ;;\n" +
      "esac\n",
  );
  chmodSync(path, 0o700);
  return path;
}

function authenticatedGitEnvironment({ token, askpass }) {
  return {
    GIT_ASKPASS: askpass,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    REGYBOX_INSTALLATION_TOKEN: token,
  };
}

function gitDeadlineOptions({ cwd, env, deadlineAt, now }) {
  return { cwd, env, deadlineAt, now };
}

export function materializeCheckout({
  targetDirectory,
  git,
  env = {},
  deadlineAt,
  now = () => Date.now(),
  maxTrackedEntries = MAX_TRACKED_ENTRIES,
  maxCheckoutBytes = MAX_CHECKOUT_BYTES,
}) {
  const options = gitDeadlineOptions({ cwd: targetDirectory, env, deadlineAt, now });
  const tree = git(["ls-tree", "-r", "-l", "-z", "HEAD"], options);
  const entries = tree === "" ? [] : tree.split("\0").filter((entry) => entry !== "");
  if (entries.length > maxTrackedEntries) {
    throw new Error(
      `checkout tree has ${entries.length} tracked entries; limit is ${maxTrackedEntries}`,
    );
  }

  let checkoutBytes = 0;
  for (const entry of entries) {
    const separator = entry.indexOf("\t");
    const metadata = separator === -1 ? "" : entry.slice(0, separator);
    const match = metadata.match(/^\d{6} blob [0-9a-f]+ +(\d+)$/);
    if (!match) {
      throw new Error("checkout tree contains an unsupported tracked entry");
    }
    checkoutBytes += Number(match[1]);
    if (!Number.isSafeInteger(checkoutBytes) || checkoutBytes > maxCheckoutBytes) {
      throw new Error(
        `checkout tree expands beyond the ${maxCheckoutBytes}-byte limit`,
      );
    }
  }

  git(
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      "checkout",
      "--quiet",
      "--detach",
      "HEAD",
    ],
    options,
  );
  return { trackedEntries: entries.length, checkoutBytes };
}

export function cloneDeployment({
  repo,
  token,
  directory,
  git,
  deadlineAt,
  now = () => Date.now(),
  maxTrackedEntries = MAX_TRACKED_ENTRIES,
  maxCheckoutBytes = MAX_CHECKOUT_BYTES,
}) {
  assertRepositoryName(repo.full_name);
  const targetDirectory = join(directory, "deployment");
  const askpass = writeAskpass(directory);
  const env = authenticatedGitEnvironment({ token, askpass });
  git(
    [
      "-c",
      "credential.helper=",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--filter=blob:none",
      "--no-checkout",
      "--single-branch",
      "--branch",
      repo.default_branch || "main",
      `https://github.com/${repo.full_name}.git`,
      targetDirectory,
    ],
    gitDeadlineOptions({ env, deadlineAt, now }),
  );
  materializeCheckout({
    targetDirectory,
    git,
    env,
    deadlineAt,
    now,
    maxTrackedEntries,
    maxCheckoutBytes,
  });
  return { targetDirectory, askpass, env };
}

async function findExistingPullRequest({
  repo,
  token,
  request,
  branch,
  checkDeadline = () => {},
}) {
  checkDeadline();
  const [owner] = repo.full_name.split("/");
  const path =
    `/repos/${repo.full_name}/pulls?state=open` +
    `&head=${encodeURIComponent(`${owner}:${branch}`)}` +
    `&base=${encodeURIComponent(repo.default_branch || "main")}`;
  const { data } = await request({ path, token });
  checkDeadline();
  return Array.isArray(data) ? data[0] ?? null : null;
}

export async function publishUpdate({
  repo,
  token,
  targetDirectory,
  env,
  git,
  request = githubRequest,
  deadlineAt,
  now = () => Date.now(),
  checkDeadline = () => {},
}) {
  const options = gitDeadlineOptions({ cwd: targetDirectory, env, deadlineAt, now });
  git(["config", "user.name", "regybox-updater[bot]"], options);
  git(["config", "user.email", "regybox-updater[bot]@users.noreply.github.com"], {
    ...options,
  });
  git(["add", "--all"], options);
  git(["commit", "-m", "chore: update Regybox scheduler"], options);
  try {
    git(
      [
        "-c",
        "credential.helper=",
        "push",
        "--no-verify",
        "origin",
        `HEAD:${repo.default_branch || "main"}`,
      ],
      options,
    );
    return { outcome: "pushed" };
  } catch (directPushError) {
    git(
      [
        "-c",
        "credential.helper=",
        "push",
        "--no-verify",
        "--force",
        "origin",
        `HEAD:refs/heads/${UPDATE_BRANCH}`,
      ],
      options,
    );
    const existing = await findExistingPullRequest({
      repo,
      token,
      request,
      branch: UPDATE_BRANCH,
      checkDeadline,
    });
    if (existing) {
      return { outcome: "pull-request", pullRequest: existing, reused: true };
    }
    checkDeadline();
    const { data } = await request({
      path: `/repos/${repo.full_name}/pulls`,
      token,
      method: "POST",
      body: {
        title: "chore: update Regybox scheduler",
        head: UPDATE_BRANCH,
        base: repo.default_branch || "main",
        body:
          "Regybox Updater could not push directly to the protected default branch. " +
          "This PR contains the same settings-safe automatic update.",
      },
    });
    checkDeadline();
    return { outcome: "pull-request", pullRequest: data, reused: false, directPushError };
  }
}

export async function reconcileRepository({
  repo,
  token,
  sourceDirectory,
  upstreamCommit,
  dryRun = false,
  request = githubRequest,
  git = createGitRunner({ secrets: [token] }),
  applyUpdate = updateFromUpstream,
  clone = cloneDeployment,
  makeTemporaryDirectory = () => mkdtempSync(join(tmpdir(), "regybox-fleet-updater-")),
  maxRepositorySizeKb = MAX_REPOSITORY_SIZE_KB,
  maxTrackedEntries = MAX_TRACKED_ENTRIES,
  maxCheckoutBytes = MAX_CHECKOUT_BYTES,
  repositoryDeadlineMs = REPOSITORY_DEADLINE_MS,
  now = () => Date.now(),
}) {
  const deadlineAt = now() + repositoryDeadlineMs;
  const checkDeadline = () => {
    if (now() >= deadlineAt) {
      throw new Error(`repository deadline exceeded after ${repositoryDeadlineMs}ms`);
    }
  };
  checkDeadline();
  const marker = await readDeploymentMarker({ repo, token, request });
  checkDeadline();
  const validation = validateMarker(marker);
  if (!validation.eligible) {
    return { outcome: "skipped", reason: validation.reason };
  }
  const repositorySizeKb = Number(repo.size);
  if (Number.isFinite(repositorySizeKb) && repositorySizeKb > maxRepositorySizeKb) {
    throw new Error(
      `eligible repository is ${repositorySizeKb}KB; limit is ${maxRepositorySizeKb}KB`,
    );
  }
  checkDeadline();
  const temporaryDirectory = makeTemporaryDirectory();
  try {
    const { targetDirectory, env } = clone({
      repo,
      token,
      directory: temporaryDirectory,
      git,
      deadlineAt,
      now,
      maxTrackedEntries,
      maxCheckoutBytes,
    });
    checkDeadline();
    applyUpdate({
      sourceDirectory,
      targetDirectory,
      installedCommit: upstreamCommit,
      checkDeadline,
    });
    checkDeadline();
    if (
      !git(
        ["status", "--porcelain"],
        gitDeadlineOptions({ cwd: targetDirectory, deadlineAt, now }),
      )
    ) {
      return { outcome: "unchanged" };
    }
    if (dryRun) {
      return { outcome: "dry-run" };
    }
    return publishUpdate({
      repo,
      token,
      targetDirectory,
      env,
      git,
      request,
      deadlineAt,
      now,
      checkDeadline,
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runFleetUpdater({
  appId,
  privateKey,
  sourceDirectory,
  upstreamCommit,
  dryRun = false,
  request = githubRequest,
  logger = console,
  createJwt = createAppJwt,
  reconcile = reconcileRepository,
  now = () => Date.now(),
  maxRepositoriesInspectedPerInstallation = MAX_REPOSITORIES_INSPECTED_PER_INSTALLATION,
  maxEligibleRepositoriesPerInstallation = MAX_ELIGIBLE_REPOSITORIES_PER_INSTALLATION,
  maxRepositoriesPerRun = MAX_REPOSITORIES_PER_RUN,
  maxRunDurationMs = MAX_RUN_DURATION_MS,
  maxRepositorySizeKb = MAX_REPOSITORY_SIZE_KB,
  maxTrackedEntries = MAX_TRACKED_ENTRIES,
  maxCheckoutBytes = MAX_CHECKOUT_BYTES,
  repositoryDeadlineMs = REPOSITORY_DEADLINE_MS,
  rotationEpochDay = Math.floor(now() / (24 * 60 * 60 * 1000)),
}) {
  const runDeadlineAt = now() + maxRunDurationMs;
  const listingJwt = createJwt({ appId, privateKey });
  const installations = await listInstallations({
    appJwt: listingJwt,
    request,
    pageSize: maxRepositoriesPerRun,
    rotationEpochDay,
  });
  const results = [];
  let failures = 0;
  const mintInstallationToken = (installationId) => {
    const freshAppJwt = createJwt({ appId, privateKey });
    return createInstallationToken({ installationId, appJwt: freshAppJwt, request });
  };
  const installationStates = [];
  for (const installation of installations) {
    if (now() >= runDeadlineAt) {
      logger.log("fleet updater: global time budget reached while loading installations");
      break;
    }
    let credentials;
    let repositories;
    try {
      credentials = await mintInstallationToken(installation.id);
      repositories = await listInstallationRepositories({
        token: credentials.token,
        request,
        pageSize: maxRepositoriesInspectedPerInstallation,
        rotationEpochDay,
        withinPageStride: maxEligibleRepositoriesPerInstallation,
      });
    } catch (error) {
      failures += 1;
      logger.error(
        `installation ${installation.id}: ${redact(error.message, [listingJwt, credentials?.token])}`,
      );
      continue;
    }
    installationStates.push({
      installation,
      credentials,
      repositories,
      cursor: 0,
      eligibleRepositories: 0,
      limitLogged: false,
    });
  }

  let attemptedRepositories = 0;
  let madeProgress = true;
  while (
    madeProgress &&
    attemptedRepositories < maxRepositoriesPerRun &&
    now() < runDeadlineAt
  ) {
    madeProgress = false;
    for (const state of installationStates) {
      if (attemptedRepositories >= maxRepositoriesPerRun || now() >= runDeadlineAt) {
        break;
      }
      if (
        state.cursor >= state.repositories.length ||
        state.eligibleRepositories >= maxEligibleRepositoriesPerInstallation
      ) {
        if (
          !state.limitLogged &&
          state.eligibleRepositories >= maxEligibleRepositoriesPerInstallation &&
          state.cursor < state.repositories.length
        ) {
          logger.log(
            `installation ${state.installation.id}: fairness limit reached ` +
              `(${state.cursor} inspected, ${state.eligibleRepositories} eligible)`,
          );
          state.limitLogged = true;
        }
        continue;
      }
      const repo = state.repositories[state.cursor];
      state.cursor += 1;
      attemptedRepositories += 1;
      madeProgress = true;
      try {
        if (state.credentials.expiresAt - now() <= INSTALLATION_TOKEN_REFRESH_WINDOW_MS) {
          state.credentials = await mintInstallationToken(state.installation.id);
        }
        const result = await reconcile({
          repo,
          token: state.credentials.token,
          sourceDirectory,
          upstreamCommit,
          dryRun,
          request,
          maxRepositorySizeKb,
          maxTrackedEntries,
          maxCheckoutBytes,
          repositoryDeadlineMs,
          now,
        });
        if (result.outcome !== "skipped" || result.eligible === true) {
          state.eligibleRepositories += 1;
        }
        results.push({ repository: repo.full_name, ...result });
        logger.log(`${repo.full_name}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
      } catch (error) {
        state.eligibleRepositories += 1;
        failures += 1;
        results.push({ repository: repo.full_name, outcome: "failed" });
        logger.error(
          `${repo.full_name}: ${redact(error.message, [listingJwt, state.credentials?.token])}`,
        );
      }
    }
  }
  if (attemptedRepositories >= maxRepositoriesPerRun) {
    logger.log(`fleet updater: global repository budget reached (${maxRepositoriesPerRun})`);
  } else if (now() >= runDeadlineAt) {
    logger.log(`fleet updater: global time budget reached (${maxRunDurationMs}ms)`);
  }
  return { installations: installations.length, results, failures };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceDirectory = resolve(scriptDirectory, "..");
  const git = createGitRunner();
  const upstreamCommit =
    process.env.REGYBOX_UPDATER_SOURCE_COMMIT || git(["rev-parse", "HEAD"], { cwd: resolve(sourceDirectory, "../..") });
  const result = await runFleetUpdater({
    appId: process.env.REGYBOX_UPDATER_APP_ID,
    privateKey: process.env.REGYBOX_UPDATER_PRIVATE_KEY,
    sourceDirectory,
    upstreamCommit,
    dryRun,
  });
  console.log(
    `Regybox fleet update complete: ${result.results.length} repositories, ${result.failures} failures`,
  );
  if (result.failures > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  await main();
}
