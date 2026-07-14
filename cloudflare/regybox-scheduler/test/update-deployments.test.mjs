import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAppJwt,
  cloneDeployment,
  createGitRunner,
  listInstallationRepositories,
  listInstallations,
  materializeCheckout,
  publishUpdate,
  reconcileRepository,
  runFleetUpdater,
  validateMarker,
} from "../scripts/update-deployments.mjs";
import { updateFromUpstream } from "../scripts/update-from-upstream.mjs";

const validMarker = {
  schemaVersion: 1,
  upstream: "martimlobao/regybox",
  channel: "main",
  mode: "auto",
  installedCommit: "old",
};

function markerResponse(marker = validMarker) {
  return {
    data: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(JSON.stringify(marker)).toString("base64"),
    },
    headers: new Headers(),
  };
}

test("GitHub App JWTs use RS256 and the configured app id", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = createAppJwt({
    appId: "12345",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    now: () => Date.parse("2026-07-14T10:00:00Z"),
  });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.equal(JSON.parse(Buffer.from(payload, "base64url")).iss, "12345");
  assert.ok(signature.length > 100);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
});

test("deployment marker validation fails closed", () => {
  assert.equal(validateMarker(validMarker).eligible, true);
  for (const marker of [
    null,
    { ...validMarker, schemaVersion: 2 },
    { ...validMarker, upstream: "someone/else" },
    { ...validMarker, channel: "unstable" },
    { ...validMarker, mode: "manual" },
    { ...validMarker, installedCommit: null },
  ]) {
    assert.equal(validateMarker(marker).eligible, false);
  }
});

test("cloning keeps installation tokens out of command arguments and remotes", () => {
  const directory = mkdtempSync(join(tmpdir(), "regybox-clone-test-"));
  const invocations = [];
  try {
    const result = cloneDeployment({
      repo: { full_name: "ana/regybox", default_branch: "main" },
      token: "installation-secret",
      directory,
      git: (args, options) => {
        invocations.push({ args, options });
        return args.includes("ls-tree") ? "100644 blob abc123 10\tworker.js\0" : "";
      },
    });
    const invocation = invocations.find(({ args }) => args.includes("clone"));
    assert.ok(invocation);
    assert.equal(
      invocation.args.includes("https://github.com/ana/regybox.git"),
      true,
    );
    const depthIndex = invocation.args.indexOf("--depth");
    assert.notEqual(depthIndex, -1);
    assert.equal(invocation.args[depthIndex + 1], "1");
    assert.equal(invocation.args.includes("--filter=blob:none"), true);
    assert.equal(invocation.args.includes("--no-checkout"), true);
    assert.doesNotMatch(JSON.stringify(invocation.args), /installation-secret/);
    assert.equal(invocation.options.env.REGYBOX_INSTALLATION_TOKEN, "installation-secret");
    assert.equal(invocation.options.env.GIT_LFS_SKIP_SMUDGE, "1");
    assert.deepEqual(
      invocations.map(({ args }) => args.find((argument) => ["clone", "ls-tree", "checkout"].includes(argument))),
      ["clone", "ls-tree", "checkout"],
    );
    assert.equal(result.targetDirectory, join(directory, "deployment"));
    const askpassEnvironment = {
      ...process.env,
      REGYBOX_INSTALLATION_TOKEN: "installation-secret",
    };
    assert.equal(
      execFileSync(
        result.askpass,
        ["Username for 'https://github.com':"],
        { encoding: "utf8", env: askpassEnvironment },
      ).trim(),
      "x-access-token",
    );
    assert.equal(
      execFileSync(
        result.askpass,
        ["Password for 'https://x-access-token@github.com':"],
        { encoding: "utf8", env: askpassEnvironment },
      ).trim(),
      "installation-secret",
    );
    assert.throws(() =>
      execFileSync(
        result.askpass,
        ["Password for 'https://evil.example':"],
        { env: askpassEnvironment },
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkout preflight enforces the tracked-entry budget before materializing files", () => {
  const calls = [];
  assert.throws(
    () =>
      materializeCheckout({
        targetDirectory: "/deployment",
        maxTrackedEntries: 1,
        git: (args) => {
          calls.push(args);
          return [
            "100644 blob abc123 1\tone.txt",
            "100644 blob def456 1\ttwo.txt",
          ].join("\0");
        },
      }),
    /2 tracked entries; limit is 1/,
  );
  assert.equal(calls.some((args) => args.includes("checkout")), false);
});

test("git child processes receive only the explicit short-lived credential", () => {
  let childOptions;
  const git = createGitRunner({
    processEnvironment: {
      PATH: "/usr/bin",
      HOME: "/home/runner",
      REGYBOX_UPDATER_PRIVATE_KEY: "root-private-key",
      REGYBOX_UPDATER_APP_ID: "app-id",
      GITHUB_TOKEN: "root-token",
      OTHER_PASSWORD: "root-password",
    },
    timeoutMs: 1_234,
    maxBuffer: 5_678,
    spawnImpl: (_command, _args, options) => {
      childOptions = options;
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  git(["status"], {
    env: {
      REGYBOX_INSTALLATION_TOKEN: "short-lived-token",
      REGYBOX_UPDATER_PRIVATE_KEY: "must-not-override",
    },
  });
  const childEnvironment = childOptions.env;
  assert.equal(childEnvironment.PATH, "/usr/bin");
  assert.equal(childEnvironment.HOME, "/home/runner");
  assert.equal(childEnvironment.REGYBOX_INSTALLATION_TOKEN, "short-lived-token");
  assert.equal(childEnvironment.REGYBOX_UPDATER_PRIVATE_KEY, undefined);
  assert.equal(childEnvironment.REGYBOX_UPDATER_APP_ID, undefined);
  assert.equal(childEnvironment.GITHUB_TOKEN, undefined);
  assert.equal(childEnvironment.OTHER_PASSWORD, undefined);
  assert.equal(childOptions.timeout, 1_234);
  assert.equal(childOptions.maxBuffer, 5_678);
});

test("git timeouts produce bounded actionable errors without leaking arguments", () => {
  const git = createGitRunner({
    timeoutMs: 25,
    spawnImpl: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync git ETIMEDOUT secret-ref"), {
        code: "ETIMEDOUT",
      }),
    }),
  });

  assert.throws(
    () => git(["push", "origin", "secret-ref"]),
    (error) => {
      assert.equal(error.message, "git push timed out after 25ms");
      assert.doesNotMatch(error.message, /secret-ref/);
      return true;
    },
  );
});

test("git commands share one shrinking repository deadline", () => {
  let clock = 0;
  const observedTimeouts = [];
  const git = createGitRunner({
    timeoutMs: 1_000,
    spawnImpl: (_command, _args, options) => {
      observedTimeouts.push(options.timeout);
      clock += 400;
      return observedTimeouts.length === 1
        ? { status: 0, stdout: "", stderr: "" }
        : {
            status: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }),
          };
    },
  });

  git(["status"], { deadlineAt: 700, now: () => clock });
  assert.throws(
    () => git(["checkout"], { deadlineAt: 700, now: () => clock }),
    /git checkout timed out after 300ms/,
  );
  assert.deepEqual(observedTimeouts, [700, 300]);
});

test("installation enumeration selects one bounded rotating page", async () => {
  const requests = [];
  const request = async ({ path }) => {
    requests.push(path);
    const page = Number(new URL(path, "https://api.github.com").searchParams.get("page"));
    return {
      data: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }, { id: 4 }],
      headers: new Headers(
        page === 1
          ? {
              link:
                '<https://api.github.com/app/installations?per_page=2&page=2>; rel="next", ' +
                '<https://api.github.com/app/installations?per_page=2&page=3>; rel="last"',
            }
          : {},
      ),
    };
  };

  assert.deepEqual(
    await listInstallations({
      appJwt: "jwt",
      request,
      pageSize: 2,
      rotationEpochDay: 1,
    }),
    [{ id: 3 }, { id: 4 }],
  );
  assert.equal(requests.length, 2);
  assert.match(requests[1], /page=2$/);
});

test("repository page windows rotate by their full cap and wrap without unbounded pagination", async () => {
  const names = ["zero", "one", "two", "three", "four"];
  const requestedPages = [];
  const request = async ({ path }) => {
    const page = Number(new URL(path, "https://api.github.com").searchParams.get("page"));
    requestedPages.push(page);
    const start = (page - 1) * 2;
    return {
      data: {
        total_count: names.length,
        repositories: names.slice(start, start + 2).map((name) => ({
          id: names.indexOf(name),
          full_name: `ana/${name}`,
        })),
      },
      headers: new Headers(),
    };
  };

  const windows = [];
  for (const rotationEpochDay of [0, 1, 2]) {
    const repositories = await listInstallationRepositories({
      token: "token",
      request,
      pageSize: 2,
      rotationEpochDay,
    });
    windows.push(repositories.map((repository) => repository.id));
  }

  assert.deepEqual(windows, [[0, 1], [2, 3], [4, 0]]);
  assert.deepEqual(requestedPages, [1, 1, 2, 1, 3]);
});

test("wrong-upstream deployments are skipped before cloning", async () => {
  let cloned = false;
  const result = await reconcileRepository({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    sourceDirectory: "/unused",
    upstreamCommit: "abc123",
    request: async () => markerResponse({ ...validMarker, upstream: "someone/else" }),
    clone: () => {
      cloned = true;
      throw new Error("should not clone");
    },
  });
  assert.equal(result.outcome, "skipped");
  assert.equal(cloned, false);
});

test("malformed deployment markers are skipped before cloning", async () => {
  let cloned = false;
  const result = await reconcileRepository({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    sourceDirectory: "/unused",
    upstreamCommit: "abc123",
    request: async () => ({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from("not json").toString("base64"),
      },
      headers: new Headers(),
    }),
    clone: () => {
      cloned = true;
      throw new Error("should not clone");
    },
  });
  assert.equal(result.outcome, "skipped");
  assert.equal(cloned, false);
});

test("no-op reconciliation does not commit or push", async () => {
  const gitCalls = [];
  const result = await reconcileRepository({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request: async () => markerResponse(),
    makeTemporaryDirectory: () => "/tmp/regybox-noop-test",
    clone: ({ directory }) => {
      const targetDirectory = join(directory, "deployment");
      mkdirSync(targetDirectory, { recursive: true });
      writeFileSync(join(targetDirectory, ".regybox-deployment.json"), JSON.stringify(validMarker));
      return { targetDirectory, env: {} };
    },
    applyUpdate: () => {},
    git: (args) => {
      gitCalls.push(args);
      return args[0] === "status" ? "" : "";
    },
  });
  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(gitCalls, [["status", "--porcelain"]]);
});

test("dry-run applies and inspects an update without commit, push, or API writes", async () => {
  const gitCalls = [];
  const apiCalls = [];
  let appliedUpdate;
  const result = await reconcileRepository({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    dryRun: true,
    request: async (options) => {
      apiCalls.push(options);
      return markerResponse();
    },
    makeTemporaryDirectory: () => "/tmp/regybox-dry-run-test",
    clone: ({ directory }) => {
      const targetDirectory = join(directory, "deployment");
      mkdirSync(targetDirectory, { recursive: true });
      writeFileSync(join(targetDirectory, ".regybox-deployment.json"), JSON.stringify(validMarker));
      return { targetDirectory, env: {} };
    },
    applyUpdate: (options) => {
      appliedUpdate = options;
    },
    git: (args) => {
      gitCalls.push(args);
      return args[0] === "status" ? " M src/index.js" : "";
    },
  });

  assert.equal(result.outcome, "dry-run");
  assert.equal(appliedUpdate.sourceDirectory, "/source");
  assert.equal(appliedUpdate.targetDirectory, "/tmp/regybox-dry-run-test/deployment");
  assert.equal(appliedUpdate.installedCommit, "abc123");
  assert.equal(typeof appliedUpdate.checkDeadline, "function");
  assert.deepEqual(gitCalls, [["status", "--porcelain"]]);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].method, undefined);
});

test("a checked-out opt-out is honored before any update mutation", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "regybox-consent-race-"));
  let applied = false;
  const result = await reconcileRepository({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request: async () => markerResponse(),
    makeTemporaryDirectory: () => temporaryDirectory,
    clone: ({ directory }) => {
      const targetDirectory = join(directory, "deployment");
      mkdirSync(targetDirectory, { recursive: true });
      writeFileSync(
        join(targetDirectory, ".regybox-deployment.json"),
        JSON.stringify({ ...validMarker, mode: "paused" }),
      );
      return { targetDirectory, env: {} };
    },
    applyUpdate: () => {
      applied = true;
    },
    git: () => {
      throw new Error("git must not run after the checked-out opt-out");
    },
  });

  assert.equal(result.outcome, "skipped");
  assert.match(result.reason, /automatic updates disabled/);
  assert.equal(applied, false);
});

test("publishing pushes directly when the default branch accepts updates", async () => {
  const calls = [];
  const result = await publishUpdate({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    targetDirectory: "/deployment",
    env: {},
    git: (args) => {
      calls.push(args);
      return "";
    },
    request: async () => {
      throw new Error("GitHub API should not be called");
    },
  });
  assert.equal(result.outcome, "pushed");
  assert.deepEqual(calls.at(-1), [
    "-c",
    "credential.helper=",
    "push",
    "--no-verify",
    "origin",
    "HEAD:main",
  ]);
});

test("a rejected direct push uses a deterministic branch and opens an update PR", async () => {
  const gitCalls = [];
  const apiCalls = [];
  const result = await publishUpdate({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    targetDirectory: "/deployment",
    env: {},
    git: (args) => {
      gitCalls.push(args);
      if (
        args.join(" ") ===
        "-c credential.helper= push --no-verify origin HEAD:main"
      ) {
        throw new Error("protected branch");
      }
      return "";
    },
    request: async (options) => {
      apiCalls.push(options);
      if (options.path.includes("/contents/.regybox-deployment.json")) {
        return markerResponse();
      }
      return options.method === "POST"
        ? { data: { number: 42 }, headers: new Headers() }
        : { data: [], headers: new Headers() };
    },
  });
  assert.equal(result.outcome, "pull-request");
  assert.equal(result.pullRequest.number, 42);
  assert.ok(
    gitCalls.some(
      (args) =>
        args.join(" ") ===
        "-c credential.helper= push --no-verify --force origin " +
          "HEAD:refs/heads/regybox-updater/main",
    ),
  );
  assert.equal(apiCalls.at(-1).method, "POST");
  assert.equal(apiCalls.at(-1).body.head, "regybox-updater/main");
});

test("PR fallback reuses an existing updater pull request", async () => {
  const apiCalls = [];
  const result = await publishUpdate({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    targetDirectory: "/deployment",
    env: {},
    git: (args) => {
      if (
        args.join(" ") ===
        "-c credential.helper= push --no-verify origin HEAD:main"
      ) {
        throw new Error("protected branch");
      }
      return "";
    },
    request: async (options) => {
      apiCalls.push(options);
      if (options.path.includes("/contents/.regybox-deployment.json")) {
        return markerResponse();
      }
      return { data: [{ number: 7 }], headers: new Headers() };
    },
  });
  assert.equal(result.pullRequest.number, 7);
  assert.equal(result.reused, true);
  assert.equal(apiCalls.length, 2);
});

test("fallback stops when consent is withdrawn after a rejected direct push", async () => {
  const gitCalls = [];
  const apiCalls = [];
  const result = await publishUpdate({
    repo: { full_name: "ana/regybox", default_branch: "main" },
    token: "token",
    targetDirectory: "/deployment",
    env: {},
    git: (args) => {
      gitCalls.push(args);
      if (
        args.join(" ") ===
        "-c credential.helper= push --no-verify origin HEAD:main"
      ) {
        throw new Error("protected branch");
      }
      return "";
    },
    request: async (options) => {
      apiCalls.push(options);
      return markerResponse({ ...validMarker, mode: "paused" });
    },
  });

  assert.equal(result.outcome, "skipped");
  assert.match(result.reason, /automatic updates disabled/);
  assert.equal(
    gitCalls.some((args) => args.includes("--force")),
    false,
  );
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls.some(({ method }) => method === "POST"), false);
});

test("one eligible repository failure does not prevent later reconciliation", async () => {
  const reconciled = [];
  const errors = [];
  const request = async ({ path, method }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 99 }], headers: new Headers() };
    }
    if (path === "/app/installations/99/access_tokens" && method === "POST") {
      return {
        data: {
          token: "installation-secret",
          expires_at: "2026-07-14T12:00:00Z",
        },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      return {
        data: {
          repositories: [
            { full_name: "ana/first", default_branch: "main" },
            { full_name: "ana/second", default_branch: "main" },
          ],
        },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const result = await runFleetUpdater({
    appId: "1",
    privateKey: "unused",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request,
    createJwt: () => "app-secret",
    now: () => Date.parse("2026-07-14T10:00:00Z"),
    reconcile: async ({ repo }) => {
      reconciled.push(repo.full_name);
      if (repo.full_name.endsWith("first")) {
        throw new Error("repository failed with installation-secret");
      }
      return { outcome: "unchanged" };
    },
    logger: { log: () => {}, error: (message) => errors.push(message) },
  });
  assert.deepEqual(reconciled, ["ana/first", "ana/second"]);
  assert.equal(result.failures, 1);
  assert.match(errors[0], /\[redacted\]/);
  assert.doesNotMatch(errors[0], /installation-secret/);
});

test("an oversized eligible repository fails visibly before cloning without blocking the next", async () => {
  const cloned = [];
  const reconciled = [];
  const errors = [];
  const request = async ({ path, method }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 99 }], headers: new Headers() };
    }
    if (path === "/app/installations/99/access_tokens" && method === "POST") {
      return {
        data: { token: "token", expires_at: "2026-07-14T12:00:00Z" },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      return {
        data: {
          repositories: [
            { full_name: "ana/a-oversized", default_branch: "main", size: 101 },
            { full_name: "ana/b-healthy", default_branch: "main", size: 1 },
          ],
        },
        headers: new Headers(),
      };
    }
    if (path.includes("/contents/.regybox-deployment.json")) {
      return markerResponse();
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const result = await runFleetUpdater({
    appId: "1",
    privateKey: "unused",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request,
    createJwt: () => "jwt",
    now: () => Date.parse("2026-07-14T10:00:00Z"),
    maxRepositorySizeKb: 100,
    reconcile: async (options) => {
      reconciled.push(options.repo.full_name);
      if (options.repo.full_name.endsWith("b-healthy")) {
        return { outcome: "unchanged" };
      }
      return reconcileRepository({
        ...options,
        clone: ({ repo }) => {
          cloned.push(repo.full_name);
          throw new Error("oversized repository must not be cloned");
        },
      });
    },
    rotationEpochDay: 0,
    logger: { log: () => {}, error: (message) => errors.push(message) },
  });

  assert.deepEqual(reconciled, ["ana/a-oversized", "ana/b-healthy"]);
  assert.deepEqual(cloned, []);
  assert.equal(result.failures, 1);
  assert.deepEqual(
    result.results.map(({ repository, outcome }) => ({ repository, outcome })),
    [
      { repository: "ana/a-oversized", outcome: "failed" },
      { repository: "ana/b-healthy", outcome: "unchanged" },
    ],
  );
  assert.match(errors[0], /eligible repository is 101KB; limit is 100KB/);
});

test("a timed-out first repository does not block the next repository", async () => {
  const reconciled = [];
  const errors = [];
  const request = async ({ path, method }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 99 }], headers: new Headers() };
    }
    if (path === "/app/installations/99/access_tokens" && method === "POST") {
      return {
        data: { token: "token", expires_at: "2026-07-14T12:00:00Z" },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      return {
        data: {
          repositories: [
            { full_name: "ana/slow", default_branch: "main" },
            { full_name: "ana/healthy", default_branch: "main" },
          ],
        },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const result = await runFleetUpdater({
    appId: "1",
    privateKey: "unused",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request,
    createJwt: () => "jwt",
    now: () => Date.parse("2026-07-14T10:00:00Z"),
    rotationEpochDay: 1,
    reconcile: async ({ repo }) => {
      reconciled.push(repo.full_name);
      if (repo.full_name.endsWith("slow")) {
        const git = createGitRunner({
          timeoutMs: 50,
          spawnImpl: () => ({
            status: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("token must stay private"), { code: "ETIMEDOUT" }),
          }),
        });
        git(["clone", "https://token@github.com/ana/slow.git"]);
      }
      return { outcome: "unchanged" };
    },
    logger: { log: () => {}, error: (message) => errors.push(message) },
  });

  assert.deepEqual(reconciled, ["ana/slow", "ana/healthy"]);
  assert.equal(result.failures, 1);
  assert.equal(result.results.at(-1).outcome, "unchanged");
  assert.match(errors[0], /git clone timed out after 50ms/);
  assert.doesNotMatch(errors[0], /token@|must stay private/);
});

test("the per-installation eligible cap preserves fairness for later installations", async () => {
  const reconciled = [];
  const logs = [];
  const request = async ({ path, method, token }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 1 }, { id: 2 }], headers: new Headers() };
    }
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint && method === "POST") {
      return {
        data: {
          token: `token-${mint[1]}`,
          expires_at: "2026-07-14T12:00:00Z",
        },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      return {
        data: {
          repositories:
            token === "token-1"
              ? [
                  { full_name: "ana/one", default_branch: "main" },
                  { full_name: "ana/two", default_branch: "main" },
                  { full_name: "ana/three", default_branch: "main" },
                ]
              : [{ full_name: "bia/four", default_branch: "main" }],
        },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const result = await runFleetUpdater({
    appId: "1",
    privateKey: "unused",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request,
    createJwt: () => "jwt",
    now: () => Date.parse("2026-07-14T10:00:00Z"),
    rotationEpochDay: 0,
    maxEligibleRepositoriesPerInstallation: 2,
    reconcile: async ({ repo }) => {
      reconciled.push(repo.full_name);
      return { outcome: "unchanged" };
    },
    logger: { log: (message) => logs.push(message), error: () => {} },
  });

  assert.deepEqual(reconciled, ["ana/one", "bia/four", "ana/two"]);
  assert.equal(result.installations, 2);
  assert.equal(result.failures, 0);
  assert.ok(logs.some((message) => message.includes("installation 1: fairness limit reached")));
});

test("the global repository budget is spent round-robin across installations", async () => {
  const reconciled = [];
  const logs = [];
  const request = async ({ path, method, token }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 1 }, { id: 2 }], headers: new Headers() };
    }
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint && method === "POST") {
      return {
        data: { token: `token-${mint[1]}`, expires_at: "2026-07-14T12:00:00Z" },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      const owner = token === "token-1" ? "ana" : "bia";
      return {
        data: {
          repositories: ["one", "two"].map((name) => ({
            full_name: `${owner}/${name}`,
            default_branch: "main",
          })),
        },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  await runFleetUpdater({
    appId: "1",
    privateKey: "unused",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request,
    createJwt: () => "jwt",
    now: () => Date.parse("2026-07-14T10:00:00Z"),
    rotationEpochDay: 0,
    maxRepositoriesPerRun: 2,
    reconcile: async ({ repo }) => {
      reconciled.push(repo.full_name);
      return { outcome: "unchanged" };
    },
    logger: { log: (message) => logs.push(message), error: () => {} },
  });

  assert.deepEqual(reconciled, ["ana/one", "bia/one"]);
  assert.ok(logs.some((message) => message.includes("global repository budget reached (2)")));
});

test("a huge installation uses a bounded repository window and cannot block the next installation", async () => {
  const reconciled = [];
  let repositoryRequests = 0;
  const request = async ({ path, method, token }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 1 }, { id: 2 }], headers: new Headers() };
    }
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint && method === "POST") {
      return {
        data: { token: `token-${mint[1]}`, expires_at: "2026-07-14T12:00:00Z" },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      repositoryRequests += 1;
      const firstInstallation = token === "token-1";
      return {
        data: {
          total_count: firstInstallation ? 1_000_000 : 1,
          repositories: [
            {
              full_name: firstInstallation ? "ana/windowed" : "bia/healthy",
              default_branch: "main",
            },
          ],
        },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const result = await runFleetUpdater({
    appId: "1",
    privateKey: "unused",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request,
    createJwt: () => "jwt",
    now: () => Date.parse("2026-07-14T10:00:00Z"),
    rotationEpochDay: 0,
    maxRepositoriesPerRun: 2,
    reconcile: async ({ repo }) => {
      reconciled.push(repo.full_name);
      return { outcome: "unchanged" };
    },
    logger: { log: () => {}, error: () => {} },
  });

  assert.deepEqual(reconciled, ["ana/windowed", "bia/healthy"]);
  assert.equal(repositoryRequests, 2);
  assert.equal(result.failures, 0);
});

test("checkout expansion failure leaves the tree unmaterialized and the next installation runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-expansion-budget-"));
  const source = join(root, "compressed-source");
  const target = join(root, "no-checkout-clone");
  const reconciled = [];
  try {
    mkdirSync(source);
    execFileSync("git", ["init", "--quiet"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: source });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
    writeFileSync(join(source, "expanded.txt"), "a".repeat(64 * 1024));
    execFileSync("git", ["add", "expanded.txt"], { cwd: source });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
      { cwd: source },
    );
    execFileSync("git", ["clone", "--quiet", "--no-checkout", source, target]);

    const request = async ({ path, method, token }) => {
      if (path.startsWith("/app/installations?")) {
        return { data: [{ id: 1 }, { id: 2 }], headers: new Headers() };
      }
      const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (mint && method === "POST") {
        return {
          data: { token: `token-${mint[1]}`, expires_at: "2026-07-14T12:00:00Z" },
          headers: new Headers(),
        };
      }
      if (path.startsWith("/installation/repositories?")) {
        return {
          data: {
            repositories: [
              {
                full_name: token === "token-1" ? "ana/compressed-bomb" : "bia/healthy",
                default_branch: "main",
              },
            ],
          },
          headers: new Headers(),
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const result = await runFleetUpdater({
      appId: "1",
      privateKey: "unused",
      sourceDirectory: "/source",
      upstreamCommit: "abc123",
      request,
      createJwt: () => "jwt",
      now: () => Date.parse("2026-07-14T10:00:00Z"),
      rotationEpochDay: 0,
      reconcile: async ({ repo }) => {
        reconciled.push(repo.full_name);
        if (repo.full_name === "ana/compressed-bomb") {
          materializeCheckout({
            targetDirectory: target,
            git: createGitRunner(),
            maxCheckoutBytes: 1_024,
          });
        }
        return { outcome: "unchanged" };
      },
      logger: { log: () => {}, error: () => {} },
    });

    assert.deepEqual(reconciled, ["ana/compressed-bomb", "bia/healthy"]);
    assert.equal(result.failures, 1);
    assert.deepEqual(
      result.results.map(({ repository, outcome }) => ({ repository, outcome })),
      [
        { repository: "ana/compressed-bomb", outcome: "failed" },
        { repository: "bia/healthy", outcome: "unchanged" },
      ],
    );
    assert.equal(existsSync(join(target, "expanded.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daily chunk rotation makes practical progress beyond the per-run prefix", async () => {
  const processedByDay = [];
  const request = async ({ path, method }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 1 }], headers: new Headers() };
    }
    if (path === "/app/installations/1/access_tokens" && method === "POST") {
      return {
        data: { token: "token", expires_at: "2026-07-14T12:00:00Z" },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
      const page = Number(new URL(path, "https://api.github.com").searchParams.get("page"));
      const start = (page - 1) * 2;
      return {
        data: {
          total_count: names.length,
          repositories: names.slice(start, start + 2).map((name) => ({
            full_name: `ana/${name}`,
            default_branch: "main",
          })),
        },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  for (const rotationEpochDay of [0, 1, 2]) {
    const processed = [];
    await runFleetUpdater({
      appId: "1",
      privateKey: "unused",
      sourceDirectory: "/source",
      upstreamCommit: "abc123",
      request,
      createJwt: () => "jwt",
      now: () => Date.parse("2026-07-14T10:00:00Z"),
      rotationEpochDay,
      maxRepositoriesInspectedPerInstallation: 2,
      reconcile: async ({ repo }) => {
        processed.push(repo.full_name);
        return { outcome: "unchanged" };
      },
      logger: { log: () => {}, error: () => {} },
    });
    processedByDay.push(processed);
  }

  assert.deepEqual(processedByDay, [
    ["ana/alpha", "ana/beta"],
    ["ana/gamma", "ana/delta"],
    ["ana/epsilon", "ana/alpha"],
  ]);
});

test("within-page rotation processes both eligible halves when the page recurs", async () => {
  const repositories = Array.from({ length: 20 }, (_unused, index) => ({
    id: index,
    full_name: `ana/repo-${String(index).padStart(2, "0")}`,
    default_branch: "main",
  }));
  const request = async ({ path, method }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 1 }], headers: new Headers() };
    }
    if (path === "/app/installations/1/access_tokens" && method === "POST") {
      return {
        data: { token: "token", expires_at: "2026-07-14T12:00:00Z" },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      return {
        data: { total_count: repositories.length, repositories },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const processedByDay = [];

  for (const rotationEpochDay of [0, 1]) {
    const processed = [];
    await runFleetUpdater({
      appId: "1",
      privateKey: "unused",
      sourceDirectory: "/source",
      upstreamCommit: "abc123",
      request,
      createJwt: () => "jwt",
      now: () => Date.parse("2026-07-14T10:00:00Z"),
      rotationEpochDay,
      maxRepositoriesInspectedPerInstallation: 20,
      maxEligibleRepositoriesPerInstallation: 10,
      reconcile: async ({ repo }) => {
        processed.push(repo.id);
        return { outcome: "unchanged" };
      },
      logger: { log: () => {}, error: () => {} },
    });
    processedByDay.push(processed);
  }

  assert.deepEqual(processedByDay, [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  ]);
});

test("later installations get fresh App JWTs and near-expiry tokens are refreshed", async () => {
  let clock = Date.parse("2026-07-14T10:00:00Z");
  let jwtCount = 0;
  let installationOneMints = 0;
  const appJwtsUsedForMints = [];
  const reconciledTokens = [];
  const request = async ({ path, method, token }) => {
    if (path.startsWith("/app/installations?")) {
      assert.equal(token, "jwt-1");
      return { data: [{ id: 1 }, { id: 2 }], headers: new Headers() };
    }
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint && method === "POST") {
      appJwtsUsedForMints.push(token);
      const installationId = Number(mint[1]);
      if (installationId === 1) {
        installationOneMints += 1;
      }
      const lifetimeMinutes = installationId === 1 && installationOneMints === 1 ? 10 : 60;
      return {
        data: {
          token: `installation-${installationId}-${installationOneMints}`,
          expires_at: new Date(clock + lifetimeMinutes * 60 * 1000).toISOString(),
        },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      const installationId = token.includes("installation-1") ? 1 : 2;
      return {
        data: {
          repositories:
            installationId === 1
              ? [
                  { full_name: "ana/first", default_branch: "main" },
                  { full_name: "ana/second", default_branch: "main" },
                ]
              : [{ full_name: "bia/third", default_branch: "main" }],
        },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const result = await runFleetUpdater({
    appId: "1",
    privateKey: "unused",
    sourceDirectory: "/source",
    upstreamCommit: "abc123",
    request,
    createJwt: () => `jwt-${++jwtCount}`,
    now: () => clock,
    rotationEpochDay: 0,
    reconcile: async ({ token }) => {
      reconciledTokens.push(token);
      if (reconciledTokens.length === 1) {
        clock += 6 * 60 * 1000;
      }
      return { outcome: "unchanged" };
    },
    logger: { log: () => {}, error: () => {} },
  });

  assert.equal(result.failures, 0);
  assert.deepEqual(appJwtsUsedForMints, ["jwt-2", "jwt-3", "jwt-4"]);
  assert.deepEqual(reconciledTokens, [
    "installation-1-1",
    "installation-2-1",
    "installation-1-2",
  ]);
});

test("a symlinked first deployment fails without mutating trusted source or blocking the next repo", async () => {
  const root = mkdtempSync(join(tmpdir(), "regybox-fleet-symlink-"));
  const source = join(root, "source");
  const malicious = join(root, "malicious");
  const healthy = join(root, "healthy");
  const external = join(root, "external.js");
  const config = '{"name":"regybox","kv_namespaces":[]}\n';
  for (const directory of [source, malicious, healthy]) {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "wrangler.jsonc"), config);
  }
  writeFileSync(join(source, "src", "worker.js"), "trusted source\n");
  writeFileSync(external, "external bytes\n");
  symlinkSync(external, join(malicious, "src", "worker.js"));
  writeFileSync(join(healthy, "src", "worker.js"), "old deployment\n");

  const request = async ({ path, method }) => {
    if (path.startsWith("/app/installations?")) {
      return { data: [{ id: 99 }], headers: new Headers() };
    }
    if (path === "/app/installations/99/access_tokens" && method === "POST") {
      return {
        data: { token: "token", expires_at: "2026-07-14T12:00:00Z" },
        headers: new Headers(),
      };
    }
    if (path.startsWith("/installation/repositories?")) {
      return {
        data: {
          repositories: [
            { full_name: "ana/malicious", default_branch: "main" },
            { full_name: "ana/healthy", default_branch: "main" },
          ],
        },
        headers: new Headers(),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const result = await runFleetUpdater({
    appId: "1",
    privateKey: "unused",
    sourceDirectory: source,
    upstreamCommit: "abc123",
    request,
    createJwt: () => "jwt",
    now: () => Date.parse("2026-07-14T10:00:00Z"),
    rotationEpochDay: 1,
    reconcile: async ({ repo }) => {
      updateFromUpstream({
        sourceDirectory: source,
        targetDirectory: repo.full_name.endsWith("malicious") ? malicious : healthy,
        installedCommit: "abc123",
      });
      return { outcome: "updated" };
    },
    logger: { log: () => {}, error: () => {} },
  });

  assert.equal(result.failures, 1);
  assert.equal(result.results.at(-1).outcome, "updated");
  assert.equal(readFileSync(join(source, "src", "worker.js"), "utf8"), "trusted source\n");
  assert.equal(readFileSync(external, "utf8"), "external bytes\n");
  assert.equal(readFileSync(join(healthy, "src", "worker.js"), "utf8"), "trusted source\n");
});
