const fallbackPayload = {
  errorCode: "unexpected_failure",
  userTitle: "Unexpected enrollment failure",
  userMessage: "The enrollment failed with an unexpected error.",
  userNextSteps: [
    "Retry the workflow once.",
    "If it fails again, share the technical details with support.",
  ],
};

const typedPayloads = {
  RegyboxLoginError: {
    errorCode: "login_error",
    userTitle: "Unable to log in to Regybox",
    userMessage:
      "The saved login session was rejected, so the automation could not access your account.",
    userNextSteps: [
      "Sign in to regybox.pt and copy fresh PHPSESSID and regybox_user cookies.",
      "Update the GitHub secrets PHPSESSID and REGYBOX_USER.",
      "Run the workflow again.",
    ],
  },
  ClassNotFoundError: {
    errorCode: "class_not_found",
    userTitle: "Requested class was not found",
    userMessage: "No matching class was found for the requested date and time.",
    userNextSteps: [
      "Check the class name and time in your workflow configuration.",
      "Confirm the class exists in Regybox for that date.",
      "Retry the workflow.",
    ],
  },
  NoClassesFoundError: {
    errorCode: "no_classes_found",
    userTitle: "No classes found for the selected date",
    userMessage: "Regybox did not list any classes for the selected date.",
    userNextSteps: [
      "Check if the gym has published that day's schedule.",
      "Confirm the selected date offset is correct in the workflow.",
      "Retry later when classes are available.",
    ],
  },
  ClassNotOpenError: {
    errorCode: "class_not_open",
    userTitle: "Enrollment is not open yet",
    userMessage: "The class exists, but enrollment is still closed.",
    userNextSteps: [
      "Wait until enrollment opens and run the workflow again.",
      "Start the workflow closer to the enrollment opening time.",
    ],
  },
  ClassIsOverbookedError: {
    errorCode: "class_overbooked",
    userTitle: "Class and waitlist are full",
    userMessage: "The class is overbooked, so no additional spots are available.",
    userNextSteps: [
      "Try a different class time.",
      "Retry later in case a spot becomes available.",
    ],
  },
  RegyboxTimeoutError: {
    errorCode: "timeout_waiting_for_enrollment",
    userTitle: "Timed out waiting for enrollment",
    userMessage: "The workflow waited too long and enrollment never opened.",
    userNextSteps: [
      "Start the workflow closer to the opening time for enrollment.",
      "Increase timeout-seconds if your schedule requires a longer wait.",
      "Retry the workflow.",
    ],
  },
  UnparseableError: {
    errorCode: "unparseable_response",
    userTitle: "Regybox returned an unexpected response",
    userMessage:
      "The website answered, but its response format was different from what the automation expects.",
    userNextSteps: [
      "Retry once in case this was temporary.",
      "If it keeps failing, share the technical details with support.",
    ],
  },
};

function formatDuration(seconds) {
  const totalSeconds = Number(seconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return String(seconds);
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = Math.floor(totalSeconds % 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

/**
 * Turn a Regybox client error into the user-facing failure contract used by
 * the composite action's notifications.
 */
export function errorPayload(error) {
  const payload = { ...(typedPayloads[error?.name] ?? fallbackPayload) };
  const message = error?.message ?? "";
  if (error?.name === "ClassNotFoundError") {
    const match = message.match(/^Unable to find class '(.+)' at (.+) on (.+)$/);
    if (match) {
      const [, classType, classTime, classDate] = match;
      payload.userMessage = `No class matching '${classType}' at ${classTime} was found on ${classDate}.`;
    }
  } else if (error?.name === "NoClassesFoundError") {
    const match = message.match(/^No classes found on (.+)$/);
    if (match) {
      payload.userMessage = `Regybox did not list any classes on ${match[1]}.`;
    }
  } else if (error?.name === "RegyboxTimeoutError") {
    const delayedOpening = message.match(/^Enrollment opens in (.+) seconds, which exceeds (.+) seconds$/);
    const timedOut = message.match(/^Timed out waiting for enrollment to open after (.+) seconds$/);
    if (delayedOpening) {
      const [, openingSeconds, timeoutSeconds] = delayedOpening;
      payload.userTitle = "Enrollment window opens later than expected";
      payload.userMessage = `The class opens in ${formatDuration(openingSeconds)}, but the workflow is configured to wait only ${timeoutSeconds} seconds.`;
    } else if (timedOut) {
      payload.userMessage = `The workflow waited ${timedOut[1]} seconds, but enrollment never opened.`;
    }
  }
  return {
    ...payload,
    technicalMessage: message,
  };
}

/** Build the stable failure-notification identity used by the Python action. */
export function buildFailureFingerprint({ operation, error }) {
  const payload = errorPayload(error);
  return `failure:${String(operation || "enroll").toLowerCase()}:${payload.errorCode}:${payload.userTitle}`;
}
