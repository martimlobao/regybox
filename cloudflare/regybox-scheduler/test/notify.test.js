import assert from "node:assert/strict";
import test from "node:test";

import { executePlan } from "../src/executor.js";
import {
  classSummary,
  composeEmail,
  emailConfigured,
  notifyFailure,
  notifyResult,
  sendEmail,
} from "../src/notify.js";
import { RegyboxLoginError } from "../src/regybox.js";

const emailEnv = {
  EMAIL_USERNAME: "regybox@example.test",
  EMAIL_PASSWORD: "app-password",
  EMAIL_TO: "owner@example.test",
};

const workerEnv = {
  PHPSESSID: "session",
  REGYBOX_USER: "user",
  ...emailEnv,
};

const failurePayload = {
  errorCode: "login_error",
  userTitle: "Unable to log in to Regybox",
  userMessage: "The automation could not authenticate with Regybox.",
  userNextSteps: ["Refresh the saved cookies.", "Run the workflow again."],
  technicalMessage: "RegyboxLoginError: missing session",
};

function dispatch({ operation = "enroll", cacheKey = "regybox:v1:calendar:test" } = {}) {
  return {
    operation,
    inputs: {
      "class-date": "2026-07-12",
      "class-time": "06:30",
      "class-type": "WOD",
      "cache-key": cacheKey,
    },
  };
}

function makeKv(entries = new Map()) {
  const writes = [];
  return {
    writes,
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(key, value, options) {
      writes.push({ key, value, options });
      entries.set(key, value);
    },
  };
}

test("class summaries and success email content match the action notification wording", () => {
  const summary = classSummary({ classType: "WOD", classDate: "2026-07-12", classTime: "06:30" });
  assert.equal(summary, "WOD on 2026-07-12 at 06:30");
  assert.deepEqual(
    composeEmail({ kind: "success", operation: "enroll", classSummary: summary }),
    {
      subject: "Regybox Auto-enroll: success for WOD on 2026-07-12 at 06:30",
      body:
        "Your Regybox auto-enrollment completed successfully.\n\n" +
        "Class: WOD on 2026-07-12 at 06:30\n\nNo errors were detected.",
    },
  );
});

test("success unenrollment email includes the optional worker status page", () => {
  assert.deepEqual(
    composeEmail({
      kind: "success",
      operation: "unenroll",
      classSummary: "Yoga on 2026-07-12 at 18:30",
      statusUrl: "https://status.example.test/regybox",
    }),
    {
      subject: "Regybox Auto-unenroll: success for Yoga on 2026-07-12 at 18:30",
      body:
        "Your Regybox auto-unenrollment completed successfully.\n\n" +
        "Class: Yoga on 2026-07-12 at 18:30\n\nNo errors were detected.\n\n" +
        "Status page: https://status.example.test/regybox",
    },
  );
});

test("failure email includes recovery steps and structured technical details", () => {
  assert.deepEqual(
    composeEmail({
      kind: "failure",
      operation: "enroll",
      classSummary: "WOD on 2026-07-12 at 06:30",
      payload: failurePayload,
    }),
    {
      subject: "Regybox Auto-enroll: failure - Unable to log in to Regybox",
      body:
        "We could not complete your Regybox auto-enrollment.\n\n" +
        "Class: WOD on 2026-07-12 at 06:30\n\n" +
        "What happened: The automation could not authenticate with Regybox.\n\n" +
        "What to do next:\n1. Refresh the saved cookies.\n2. Run the workflow again.\n\n" +
        "Technical details (for support):\nTechnical message: RegyboxLoginError: missing session",
    },
  );
});

test("failure technical details are capped at the Python appendix limit", () => {
  const technicalMessage = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join("\n");
  const email = composeEmail({
    kind: "failure",
    operation: "enroll",
    classSummary: "WOD on 2026-07-12 at 06:30",
    payload: { ...failurePayload, technicalMessage },
  });
  const appendix = email.body.split("Technical details (for support):\n")[1];

  assert.equal(appendix.split("\n").length, 12);
  assert.equal(appendix.split("\n").at(-1), "... (truncated)");
});

test("email configuration requires each non-empty SMTP credential and recipient", () => {
  assert.equal(emailConfigured(emailEnv), true);
  assert.equal(emailConfigured({ ...emailEnv, EMAIL_PASSWORD: " " }), false);
  assert.equal(emailConfigured({ ...emailEnv, EMAIL_TO: "" }), false);
});

test("sendEmail uses the worker-mailer SMTP API through an injectable transport", async () => {
  let connection;
  let message;
  await sendEmail(
    { ...emailEnv, EMAIL_SERVER: "smtp.example.test", EMAIL_PORT: "587", EMAIL_FROM_NAME: "Regybox" },
    { subject: "Subject", body: "Body" },
    {
      mailerFactory: async () => ({
        send: async (options, email) => {
          connection = options;
          message = email;
        },
      }),
    },
  );

  assert.deepEqual(connection, {
    host: "smtp.example.test",
    port: 587,
    secure: false,
    credentials: { username: "regybox@example.test", password: "app-password" },
    authType: "plain",
  });
  assert.deepEqual(message, {
    from: { name: "Regybox", email: "regybox@example.test" },
    to: "owner@example.test",
    subject: "Subject",
    text: "Body",
  });
});

test("a repeated failure fingerprint is suppressed", async () => {
  const item = dispatch();
  const fingerprint = "failure:enroll:login_error:Unable to log in to Regybox";
  const kv = makeKv(new Map([[item.inputs["cache-key"], JSON.stringify({ failureNotificationFingerprint: fingerprint })]]));
  let sends = 0;

  await notifyFailure({
    env: emailEnv,
    kv,
    dispatch: item,
    error: new Error("failed"),
    payload: failurePayload,
    fingerprint,
    send: async () => {
      sends += 1;
    },
  });

  assert.equal(sends, 0);
  assert.deepEqual(kv.writes, []);
});

test("a new failure fingerprint sends and is persisted only after delivery", async () => {
  const item = dispatch();
  const kv = makeKv(new Map([[item.inputs["cache-key"], JSON.stringify({ state: "not_open" })]]));
  const fingerprint = "failure:enroll:login_error:Unable to log in to Regybox";
  let sends = 0;

  await notifyFailure({
    env: emailEnv,
    kv,
    dispatch: item,
    error: new Error("failed"),
    payload: failurePayload,
    fingerprint,
    send: async () => {
      sends += 1;
      assert.deepEqual(kv.writes, []);
    },
  });

  assert.equal(sends, 1);
  assert.deepEqual(kv.writes, [
    {
      key: item.inputs["cache-key"],
      value: JSON.stringify({ state: "not_open", failureNotificationFingerprint: fingerprint }),
      options: { expirationTtl: 2592000 },
    },
  ]);
});

test("a failed email delivery never records a failure fingerprint or throws", async () => {
  const kv = makeKv();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await notifyFailure({
      env: emailEnv,
      kv,
      dispatch: dispatch(),
      error: new Error("failed"),
      payload: failurePayload,
      fingerprint: "failure:enroll:login_error:Unable to log in to Regybox",
      send: async () => {
        throw new Error("SMTP unavailable");
      },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(kv.writes, []);
});

test("noop results and unconfigured SMTP settings do not send or touch KV", async () => {
  const item = dispatch();
  const kv = {
    async get() {
      throw new Error("KV should not be read");
    },
    async put() {
      throw new Error("KV should not be written");
    },
  };
  let sends = 0;
  const send = async () => {
    sends += 1;
  };

  await notifyResult({ env: emailEnv, kv, dispatch: item, result: { status: "noop" }, send });
  await notifyFailure({
    env: {},
    kv,
    dispatch: item,
    error: new Error("failed"),
    payload: failurePayload,
    fingerprint: "failure:enroll:login_error:Unable to log in to Regybox",
    send,
  });

  assert.equal(sends, 0);
});

test("executor's worker default notification hook sends failures, while dispatch mode does not", async () => {
  const sent = [];
  const kv = makeKv();
  await executePlan({
    env: workerEnv,
    kv,
    dispatches: [dispatch()],
    createClient: () => ({ bootstrapSession: async () => {} }),
    runOperationImpl: async () => {
      throw new RegyboxLoginError();
    },
    notifyFailureImpl: (notification) =>
      notifyFailure({ ...notification, send: async (_env, email) => sent.push(email) }),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /failure - Unable to log in to Regybox$/);

  let dispatchNotifications = 0;
  await executePlan({
    env: { ...workerEnv, GITHUB_TOKEN: "token", GITHUB_OWNER: "martim", GITHUB_REPO: "regybox" },
    kv: makeKv(),
    dispatches: [dispatch()],
    dispatchWorkflowImpl: async () => {},
    notifyFailureImpl: async () => {
      dispatchNotifications += 1;
    },
    notifyResultImpl: async () => {
      dispatchNotifications += 1;
    },
  });
  assert.equal(dispatchNotifications, 0);
});
