"""Compose plain-English GitHub Action email notifications."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import cast

from regybox.exceptions import REGYBOX_USER_ERROR_PREFIX, UserErrorPayload

MAX_APPENDIX_LINES: int = 12


def read_log_text(path: str | None) -> str:
    """Read the enrollment log file if present.

    Returns:
        The full log text, or an empty string when unavailable.
    """
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _try_parse_json(raw: str) -> dict[str, object] | None:
    """Parse a JSON dictionary, tolerating surrounding log prefixes.

    Returns:
        A parsed dictionary when successful, otherwise ``None``.
    """
    try:
        parsed: object = json.loads(raw)
    except json.JSONDecodeError:
        match: re.Match[str] | None = re.search(r"\{.*\}", raw)
        if match is None:
            return None
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    if not isinstance(parsed, dict):
        return None
    return cast("dict[str, object]", parsed)


def _normalize_steps(value: object) -> tuple[str, ...]:
    """Normalize arbitrary step values into immutable strings.

    Returns:
        A tuple of non-empty step strings.
    """
    if isinstance(value, list):
        return tuple(str(step) for step in cast("list[object]", value) if str(step).strip())
    if isinstance(value, tuple):
        return tuple(str(step) for step in value if str(step).strip())  # pyright: ignore[reportUnknownArgumentType,reportUnknownVariableType]
    if isinstance(value, str) and value.strip():
        return (value.strip(),)
    return ()


def extract_user_error_payload(log_text: str) -> UserErrorPayload | None:
    """Extract the latest machine-readable Regybox error payload from logs.

    Returns:
        The parsed payload if found, otherwise ``None``.
    """
    for line in reversed(log_text.splitlines()):
        index: int = line.find(REGYBOX_USER_ERROR_PREFIX)
        if index < 0:
            continue
        raw_payload: str = line[index + len(REGYBOX_USER_ERROR_PREFIX) :].strip()
        parsed: dict[str, object] | None = _try_parse_json(raw_payload)
        if parsed is None:
            continue
        return {
            "error_code": str(parsed.get("error_code", "unknown_error")),
            "user_title": str(parsed.get("user_title", "Unexpected enrollment issue")),
            "user_message": str(
                parsed.get("user_message", "The enrollment could not be completed.")
            ),
            "user_next_steps": list(_normalize_steps(parsed.get("user_next_steps"))),
            "technical_message": str(parsed.get("technical_message", "")),
        }
    return None


def _looks_like_exception_line(line: str) -> bool:
    stripped: str = line.strip()
    if not stripped or stripped.startswith("File "):
        return False
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_.]*(?:: .+)?$", stripped))


def extract_traceback(log_text: str) -> str | None:
    """Extract the most recent traceback block from log text.

    Returns:
        The traceback text when present, otherwise ``None``.
    """
    lines: list[str] = log_text.splitlines()
    starts: list[int] = [
        index for index, line in enumerate(lines) if "Traceback (most recent call last):" in line
    ]
    if not starts:
        return None

    start: int = starts[-1]
    collected: list[str] = []
    for line in lines[start:]:
        stripped_line: str = line.rstrip()
        if not stripped_line and collected:
            break
        collected.append(stripped_line)
        if len(collected) > 1 and _looks_like_exception_line(stripped_line):
            break

    cleaned: str = "\n".join(line for line in collected if line).strip()
    return cleaned or None


def _strip_log_prefix(line: str) -> str:
    """Remove logger and symbol prefixes from one log line.

    Returns:
        A simplified line suitable for keyword matching.
    """
    candidate: str = line.strip()
    if " - " in candidate:
        candidate = candidate.rsplit(" - ", maxsplit=1)[-1].strip()
    return re.sub(r"^[^A-Za-z0-9]+", "", candidate).strip()


def extract_error_signal(log_text: str) -> str | None:
    """Extract a useful error line when traceback is unavailable.

    Returns:
        The last matching error line, or ``None`` when no signal is found.
    """
    keywords: tuple[str, ...] = (
        "error",
        "exception",
        "failed",
        "unable",
        "timeout",
        "timed out",
    )
    for line in reversed(log_text.splitlines()):
        cleaned: str = _strip_log_prefix(line)
        if not cleaned:
            continue
        lowered: str = cleaned.lower()
        if any(keyword in lowered for keyword in keywords):
            return cleaned
    return None


def _fallback_user_payload(signal: str | None) -> UserErrorPayload:
    """Translate non-Regybox failures into plain-English guidance.

    Returns:
        A fallback payload suitable for user-facing notifications.
    """
    if not signal:
        return {
            "error_code": "unexpected_failure",
            "user_title": "Unexpected enrollment failure",
            "user_message": "The enrollment failed for an unknown reason.",
            "user_next_steps": [
                "Retry the workflow once.",
                "If it fails again, share the technical details with support.",
            ],
            "technical_message": "",
        }

    lowered: str = signal.lower()
    if "unable to log in" in lowered or "regyboxloginerror" in lowered:
        return {
            "error_code": "login_error",
            "user_title": "Unable to log in to Regybox",
            "user_message": "The automation could not authenticate with Regybox.",
            "user_next_steps": [
                "Refresh PHPSESSID and REGYBOX_USER secrets from a new login session.",
                "Run the workflow again.",
            ],
            "technical_message": signal,
        }
    if "timeout" in lowered or "timed out" in lowered or "more than allowed maximum" in lowered:
        return {
            "error_code": "timeout_waiting_for_enrollment",
            "user_title": "Timed out waiting for enrollment",
            "user_message": "The workflow waited too long and stopped before enrollment opened.",
            "user_next_steps": [
                "Schedule the workflow closer to class opening time.",
                "Increase timeout-seconds if needed.",
                "Retry the workflow.",
            ],
            "technical_message": signal,
        }
    if (
        "dns error" in lowered
        or "failed to lookup address information" in lowered
        or "connection" in lowered
        or "request failed" in lowered
        or "failed to download" in lowered
    ):
        return {
            "error_code": "network_error",
            "user_title": "Temporary network issue",
            "user_message": (
                "A network problem blocked the workflow from reaching a required service."
            ),
            "user_next_steps": [
                "Retry the workflow.",
                "If the problem continues, wait a few minutes and retry again.",
            ],
            "technical_message": signal,
        }
    return {
        "error_code": "unexpected_failure",
        "user_title": "Unexpected enrollment failure",
        "user_message": "The enrollment failed with an unexpected error.",
        "user_next_steps": [
            "Retry the workflow once.",
            "If it fails again, share the technical details with support.",
        ],
        "technical_message": signal,
    }


def _trim_appendix(text: str) -> str:
    """Limit technical appendix size for readability.

    Returns:
        The appendix text, truncated when necessary.
    """
    lines: list[str] = text.splitlines()
    if len(lines) <= MAX_APPENDIX_LINES:
        return text
    return "\n".join([*lines[: MAX_APPENDIX_LINES - 1], "... (truncated)"])


def build_technical_appendix(log_text: str, technical_message: str) -> str:
    """Build a compact technical snippet for support follow-up.

    Returns:
        A short technical appendix, or an empty string.
    """
    traceback_text: str | None = extract_traceback(log_text)
    signal: str | None = extract_error_signal(log_text)

    parts: list[str] = []
    if technical_message:
        parts.append(f"Technical message: {technical_message}")
    if traceback_text:
        parts.append(f"Traceback:\n{traceback_text}")
    elif signal and signal != technical_message:
        parts.append(f"Log signal: {signal}")
    if not parts:
        return ""
    return _trim_appendix("\n\n".join(parts))


def _build_run_url(run_url: str | None) -> str:
    """Build a workflow run URL from explicit input or GitHub metadata.

    Returns:
        A workflow run URL when available.
    """
    if run_url:
        return run_url
    server: str | None = os.environ.get("GITHUB_SERVER_URL")
    repository: str | None = os.environ.get("GITHUB_REPOSITORY")
    run_id: str | None = os.environ.get("GITHUB_RUN_ID")
    if server and repository and run_id:
        return f"{server}/{repository}/actions/runs/{run_id}"
    return ""


def build_email_content(
    *,
    enroll_result: str,
    class_summary: str,
    run_url: str | None,
    log_text: str,
) -> tuple[str, str]:
    """Create email subject and body from run context.

    Returns:
        A ``(subject, body)`` tuple ready for SMTP dispatch.
    """
    normalized_result: str = enroll_result.strip().lower()
    resolved_run_url: str = _build_run_url(run_url)

    if normalized_result == "success":
        subject = f"Regybox Auto-enroll: success for {class_summary}"
        body_lines: list[str] = [
            "Your Regybox auto-enrollment completed successfully.",
            "",
            f"Class: {class_summary}",
            "",
            "No errors were detected.",
        ]
        if resolved_run_url:
            body_lines.extend(["", f"Workflow run (optional): {resolved_run_url}"])
        return subject, "\n".join(body_lines)

    payload: UserErrorPayload | None = extract_user_error_payload(log_text)
    if payload is None:
        payload = _fallback_user_payload(extract_error_signal(log_text))

    steps: list[str] = payload["user_next_steps"] or [
        "Retry the workflow once.",
        "If it fails again, share the technical details with support.",
    ]
    appendix: str = build_technical_appendix(log_text, payload["technical_message"])

    subject = f"Regybox Auto-enroll: failure - {payload['user_title']}"
    body_lines = [
        "We could not complete your Regybox auto-enrollment.",
        "",
        f"Class: {class_summary}",
        "",
        f"What happened: {payload['user_message']}",
        "",
        "What to do next:",
    ]
    body_lines.extend(f"{index}. {step}" for index, step in enumerate(steps, start=1))
    if appendix:
        body_lines.extend(["", "Technical details (for support):", appendix])
    if resolved_run_url:
        body_lines.extend(["", f"Workflow run (optional): {resolved_run_url}"])
    return subject, "\n".join(body_lines)


def write_multiline_env(*, name: str, value: str, github_env_path: str) -> None:
    """Write a multiline variable to ``GITHUB_ENV``."""
    delimiter: str = f"REGYBOX_{name}_EOF"
    with Path(github_env_path).open("a", encoding="utf-8") as env_file:
        env_file.write(f"{name}<<{delimiter}\n")
        env_file.write(f"{value}\n")
        env_file.write(f"{delimiter}\n")


def main() -> None:
    """Entry point used by the composite GitHub Action.

    Raises:
        RuntimeError: If ``GITHUB_ENV`` is not available in the environment.
    """
    github_env_path: str | None = os.environ.get("GITHUB_ENV")
    if not github_env_path:
        raise RuntimeError("GITHUB_ENV is required to compose email notification content.")

    class_summary: str = (
        f"{os.environ.get('CLASS_TYPE', 'Unknown class')} on "
        f"{os.environ.get('CLASS_DATE', 'Unknown date')} at "
        f"{os.environ.get('CLASS_TIME', 'Unknown time')}"
    )
    log_text: str = read_log_text(os.environ.get("ENROLL_LOG_PATH"))
    subject, body = build_email_content(
        enroll_result=os.environ.get("ENROLL_RESULT", "failure"),
        class_summary=class_summary,
        run_url=os.environ.get("ACTION_RUN_URL"),
        log_text=log_text,
    )
    write_multiline_env(name="EMAIL_SUBJECT", value=subject, github_env_path=github_env_path)
    write_multiline_env(name="EMAIL_BODY", value=body, github_env_path=github_env_path)


if __name__ == "__main__":
    main()
