"""Tests for plain-English email notification composition."""

import json

from regybox.exceptions import REGYBOX_USER_ERROR_PREFIX, UnplannedClassError
from regybox.notifications import (
    build_email_content,
    extract_error_signal,
    extract_traceback,
    extract_user_error_payload,
    read_log_text,
)


def test_extract_user_error_payload() -> None:
    payload = {
        "error_code": "login_error",
        "user_title": "Unable to log in to Regybox",
        "user_message": "The saved login session was rejected.",
        "user_next_steps": ["Refresh secrets", "Retry workflow"],
        "technical_message": "Unable to log in",
    }
    log = (
        "2026-03-04 00:00:00,000 ERROR [REGYBOX] [__main__.py:10] - "
        f"{REGYBOX_USER_ERROR_PREFIX}{json.dumps(payload)}"
    )

    parsed = extract_user_error_payload(log)

    assert parsed is not None
    assert parsed["error_code"] == "login_error"
    assert parsed["user_title"] == "Unable to log in to Regybox"
    assert parsed["user_next_steps"] == ["Refresh secrets", "Retry workflow"]


def test_extract_traceback() -> None:
    traceback_text = (
        "INFO something\n"
        "Traceback (most recent call last):\n"
        '  File "/tmp/job.py", line 10, in <module>\n'
        "    raise ValueError('boom')\n"
        "ValueError: boom\n"
        "WARN done"
    )

    parsed = extract_traceback(traceback_text)

    assert parsed is not None
    assert "Traceback (most recent call last):" in parsed
    assert "ValueError: boom" in parsed


def test_extract_error_signal() -> None:
    log_text = (
        "WARN Retry attempt #2\n"
        "Failed to download `coverage==7.13.2`\n"
        "failed to lookup address information: nodename nor servname provided"
    )

    signal = extract_error_signal(log_text)

    assert signal == "failed to lookup address information: nodename nor servname provided"


def test_build_email_content_from_structured_payload() -> None:
    payload = {
        "error_code": "login_error",
        "user_title": "Unable to log in to Regybox",
        "user_message": "The saved login session was rejected.",
        "user_next_steps": [
            "Refresh PHPSESSID and REGYBOX_USER secrets.",
            "Run the workflow again.",
        ],
        "technical_message": "Unable to log in",
    }
    log_text = (
        "2026-03-04 00:00:00,000 ERROR [REGYBOX] [__main__.py:10] - "
        f"{REGYBOX_USER_ERROR_PREFIX}{json.dumps(payload)}"
    )

    subject, body = build_email_content(
        enroll_result="failure",
        class_summary="WOD Rato on 2026-03-04 at 06:30",
        run_url="https://github.com/org/repo/actions/runs/123",
        log_text=log_text,
    )

    assert subject == "Regybox Auto-enroll: failure - Unable to log in to Regybox"
    assert "What happened: The saved login session was rejected." in body
    assert "1. Refresh PHPSESSID and REGYBOX_USER secrets." in body
    assert "Workflow run (optional): https://github.com/org/repo/actions/runs/123" in body


def test_build_email_content_with_fallback_translation() -> None:
    log_text = (
        "WARN Retry attempt #2\n"
        "Failed to download `coverage==7.13.2`\n"
        "failed to lookup address information: nodename nor servname provided"
    )

    subject, body = build_email_content(
        enroll_result="failure",
        class_summary="WOD Rato on 2026-03-04 at 06:30",
        run_url="",
        log_text=log_text,
    )

    assert subject == "Regybox Auto-enroll: failure - Temporary network issue"
    assert "A network problem blocked the workflow from reaching a required service." in body
    assert "Technical details (for support):" in body


def test_build_email_content_success() -> None:
    subject, body = build_email_content(
        enroll_result="success",
        class_summary="WOD Rato on 2026-03-04 at 06:30",
        run_url="https://github.com/org/repo/actions/runs/123",
        log_text="",
    )

    assert subject == "Regybox Auto-enroll: success for WOD Rato on 2026-03-04 at 06:30"
    assert "Your Regybox auto-enrollment completed successfully." in body
    assert "No errors were detected." in body


def test_build_email_content_includes_calendar_event_name_for_unplanned_class() -> None:
    payload = UnplannedClassError(
        class_type="WOD Rato",
        event_name="Crossfit",
        class_isotime="2026-03-04T06:30:00",
    ).to_user_payload()
    log_text = (
        "2026-03-04 00:00:00,000 ERROR [REGYBOX] [__main__.py:10] - "
        f"{REGYBOX_USER_ERROR_PREFIX}{json.dumps(payload)}"
    )

    subject, body = build_email_content(
        enroll_result="failure",
        class_summary="WOD Rato on 2026-03-04 at 06:30",
        run_url="",
        log_text=log_text,
    )

    assert subject == "Regybox Auto-enroll: failure - Class not found on your calendar"
    assert "What happened: The automation expected CrossFit class 'WOD Rato'" in body
    assert "as 'Crossfit'" in body


def test_email_appendix_is_trimmed() -> None:
    traceback_lines = [
        "Traceback (most recent call last):",
        '  File "/tmp/job.py", line 1, in <module>',
        "    raise RuntimeError('boom')",
    ]
    traceback_lines.extend(f"line {index}" for index in range(20))
    traceback_lines.append("RuntimeError: boom")
    log_text = "\n".join(traceback_lines)

    _, body = build_email_content(
        enroll_result="failure",
        class_summary="WOD Rato on 2026-03-04 at 06:30",
        run_url="",
        log_text=log_text,
    )

    assert "Technical details (for support):" in body
    assert "... (truncated)" in body


def test_read_log_text_none_returns_empty() -> None:
    assert read_log_text(None) == ""  # noqa: PLC1901


def test_read_log_text_missing_file_returns_empty() -> None:
    assert read_log_text("/nonexistent/path/12345") == ""  # noqa: PLC1901


def test_extract_user_error_payload_returns_none_when_no_payload() -> None:
    assert extract_user_error_payload("plain log line\nanother line") is None


def test_extract_user_error_payload_with_tuple_next_steps() -> None:
    """user_next_steps as tuple in payload is normalized to list of strings."""
    payload = {
        "error_code": "login_error",
        "user_title": "Title",
        "user_message": "Message",
        "user_next_steps": ("Step one", "Step two"),
        "technical_message": "Technical",
    }
    log = f"ERROR {REGYBOX_USER_ERROR_PREFIX}{json.dumps(payload)}"
    parsed = extract_user_error_payload(log)
    assert parsed is not None
    assert parsed["user_next_steps"] == ["Step one", "Step two"]


def test_extract_user_error_payload_with_trailing_json() -> None:
    """Payload can be parsed when prefixed by log text."""
    payload = {"error_code": "x", "user_title": "T", "user_message": "M", "technical_message": ""}
    log = f"2026-03-04 00:00:00 ERROR [REGYBOX] - {REGYBOX_USER_ERROR_PREFIX}{json.dumps(payload)}"
    parsed = extract_user_error_payload(log)
    assert parsed is not None
    assert parsed["error_code"] == "x"


def test_extract_user_error_payload_skips_line_with_invalid_json_after_prefix() -> None:
    """Lines where JSON after prefix is invalid are skipped."""
    # First line valid, second has prefix but invalid inner JSON
    valid = {"error_code": "a", "user_title": "A", "user_message": "M", "technical_message": ""}
    log = (
        f"ERROR {REGYBOX_USER_ERROR_PREFIX}{json.dumps(valid)}\n"
        f"ERROR {REGYBOX_USER_ERROR_PREFIX}prefix {{ not valid json }}"
    )
    parsed = extract_user_error_payload(log)
    # Should return the last (first in reversed) valid payload
    assert parsed is not None
    assert parsed["error_code"] == "a"


def test_extract_user_error_payload_skips_non_dict_json() -> None:
    """Lines where payload is valid JSON but not a dict are skipped."""
    log = f"ERROR {REGYBOX_USER_ERROR_PREFIX}[1, 2, 3]"
    assert extract_user_error_payload(log) is None
