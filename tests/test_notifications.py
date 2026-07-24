"""Tests for plain-English email notification composition."""

import json
import runpy
from pathlib import Path
from unittest.mock import patch

import pytest

from regybox import notifications as notifications_module
from regybox.cloudflare_kv import KV_TTL_SECONDS, CloudflareKVConfig
from regybox.exceptions import REGYBOX_USER_ERROR_PREFIX, UnplannedClassError
from regybox.notifications import (
    _fallback_user_payload,
    _normalize_steps,
    _try_parse_json,
    build_email_content,
    build_failure_notification_fingerprint,
    build_technical_appendix,
    extract_error_signal,
    extract_traceback,
    extract_user_error_payload,
    read_kv_json,
    read_log_text,
    record_delivered_failure_notification,
    should_send_email,
    should_send_email_for_state,
    write_kv_json,
    write_multiline_env,
)

FAKE_CREDENTIAL = "not-a-real-value"
NOTIFICATION_CONTRACTS = json.loads(
    (Path(__file__).parent / "fixtures" / "notification_contracts.json").read_text(
        encoding="utf-8"
    )
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


def test_build_email_content_unenroll_success() -> None:
    subject, body = build_email_content(
        operation="unenroll",
        enroll_result="success",
        class_summary="WOD on 2026-03-04 at 06:30",
        run_url="",
        log_text="",
    )

    assert subject == "Regybox Auto-unenroll: success for WOD on 2026-03-04 at 06:30"
    assert "Your Regybox auto-unenrollment completed successfully." in body


def test_build_email_content_unenroll_reconciliation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = NOTIFICATION_CONTRACTS["reconciled_unenrollment"]
    for variable in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"):
        monkeypatch.delenv(variable, raising=False)

    subject, body = build_email_content(
        operation="unenroll",
        enroll_result="noop",
        class_summary=contract["class_summary"],
        run_url="",
        log_text="",
    )

    assert subject == contract["subject"]
    assert body == contract["body"]

    _, linked_body = build_email_content(
        operation="unenroll",
        enroll_result="noop",
        class_summary=contract["class_summary"],
        run_url="https://example.com/run",
        log_text="",
    )
    assert linked_body.endswith("Workflow run (optional): https://example.com/run")


def test_build_email_content_unenroll_failure() -> None:
    subject, body = build_email_content(
        operation="unenroll",
        enroll_result="failure",
        class_summary="WOD on 2026-03-04 at 06:30",
        run_url="https://example.com/run",
        log_text="Error details here",
    )

    assert subject == "Regybox Auto-unenroll: failure - Unexpected enrollment failure"
    assert "We could not complete your Regybox auto-unenrollment." in body
    assert "Error details here" in body


def test_should_send_email_skips_noop_results() -> None:
    assert not should_send_email("noop")
    assert not should_send_email("noop", operation="unenroll")
    assert should_send_email(
        "noop",
        operation="unenroll",
        notify_unenroll_noop=True,
    )
    assert should_send_email("success")
    assert should_send_email("failure")


def test_failure_notification_fingerprint_uses_structured_payload() -> None:
    payload = {
        "error_code": "class_overbooked",
        "user_title": "Class and waitlist are full",
        "user_message": "No spots are available.",
        "user_next_steps": ["Retry later."],
        "technical_message": "Class is overbooked",
    }
    log_text = f"ERROR {REGYBOX_USER_ERROR_PREFIX}{json.dumps(payload)}"

    assert (
        build_failure_notification_fingerprint(
            enroll_result="failure",
            operation="enroll",
            log_text=log_text,
        )
        == "failure:enroll:class_overbooked:Class and waitlist are full"
    )


def test_failure_notification_fingerprint_empty_for_success() -> None:
    assert not build_failure_notification_fingerprint(
        enroll_result="success",
        operation="enroll",
        log_text="",
    )


def test_should_send_email_for_state_delegates_non_failures() -> None:
    assert should_send_email_for_state(
        enroll_result="success",
        current_failure_fingerprint="",
        cached_failure_fingerprint=None,
    )
    assert not should_send_email_for_state(
        enroll_result="noop",
        current_failure_fingerprint="",
        cached_failure_fingerprint=None,
    )


def test_should_send_email_for_state_suppresses_repeated_failure() -> None:
    fingerprint = "failure:enroll:class_overbooked:Class and waitlist are full"

    assert not should_send_email_for_state(
        enroll_result="failure",
        current_failure_fingerprint=fingerprint,
        cached_failure_fingerprint=fingerprint,
    )


def test_should_send_email_for_state_sends_different_failure() -> None:
    assert should_send_email_for_state(
        enroll_result="failure",
        current_failure_fingerprint="failure:enroll:login_error:Unable to log in to Regybox",
        cached_failure_fingerprint="failure:enroll:class_overbooked:Class and waitlist are full",
    )


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


def test_try_parse_json_returns_none_when_no_json_object_present() -> None:
    assert _try_parse_json("ERROR no JSON payload here") is None


def test_normalize_steps_handles_tuple_and_string_values() -> None:
    assert _normalize_steps(("Step one", " ", "Step two")) == ("Step one", "Step two")
    assert _normalize_steps("  Retry workflow  ") == ("Retry workflow",)


def test_extract_traceback_stops_at_blank_line() -> None:
    log_text = (
        "Traceback (most recent call last):\n"
        '  File "/tmp/job.py", line 1, in <module>\n'
        "    raise RuntimeError('boom')\n"
        "RuntimeError: boom\n"
        "\n"
        "WARN ignored"
    )

    parsed = extract_traceback(log_text)

    assert parsed is not None
    assert "RuntimeError: boom" in parsed
    assert "WARN ignored" not in parsed


def test_extract_error_signal_skips_empty_cleaned_lines() -> None:
    log_text = "\n---\nINFO all good\nERROR actual failure"

    assert extract_error_signal(log_text) == "ERROR actual failure"


def test_fallback_user_payload_without_signal() -> None:
    payload = _fallback_user_payload(None)

    assert payload["error_code"] == "unexpected_failure"
    assert not payload["technical_message"]


def test_fallback_user_payload_login_signal() -> None:
    payload = _fallback_user_payload("RegyboxLoginError: saved session expired")

    assert payload["error_code"] == "login_error"
    assert payload["user_title"] == "Unable to log in to Regybox"


def test_fallback_user_payload_timeout_signal() -> None:
    payload = _fallback_user_payload("Timed out waiting for enrollment")

    assert payload["error_code"] == "timeout_waiting_for_enrollment"
    assert payload["user_title"] == "Timed out waiting for enrollment"


def test_build_technical_appendix_returns_empty_without_signal_or_traceback() -> None:
    assert not build_technical_appendix("INFO all good", "")


def test_build_email_content_uses_github_metadata_run_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://github.com")
    monkeypatch.setenv("GITHUB_REPOSITORY", "org/repo")
    monkeypatch.setenv("GITHUB_RUN_ID", "321")

    _, body = build_email_content(
        enroll_result="success",
        class_summary="WOD Rato on 2026-03-04 at 06:30",
        run_url="",
        log_text="",
    )

    assert "Workflow run (optional): https://github.com/org/repo/actions/runs/321" in body


def test_write_multiline_env_writes_expected_format(tmp_path: Path) -> None:
    env_path = tmp_path / "github.env"

    write_multiline_env(
        name="EMAIL_BODY",
        value="line one\nline two",
        github_env_path=str(env_path),
    )

    assert env_path.read_text(encoding="utf-8") == (
        "EMAIL_BODY<<REGYBOX_EMAIL_BODY_EOF\nline one\nline two\nREGYBOX_EMAIL_BODY_EOF\n"
    )


def test_notifications_main_requires_github_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GITHUB_ENV", raising=False)

    with pytest.raises(RuntimeError, match="GITHUB_ENV is required"):
        notifications_module.main()


def test_notifications_module_main_writes_email_content(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    env_path = tmp_path / "github.env"
    log_path = tmp_path / "enroll.log"
    log_path.write_text("", encoding="utf-8")

    monkeypatch.setenv("GITHUB_ENV", str(env_path))
    monkeypatch.setenv("ENROLL_RESULT", "success")
    monkeypatch.setenv("CLASS_TYPE", "WOD Rato")
    monkeypatch.setenv("CLASS_DATE", "2026-03-04")
    monkeypatch.setenv("CLASS_TIME", "06:30")
    monkeypatch.setenv("ENROLL_LOG_PATH", str(log_path))
    monkeypatch.setenv("ACTION_RUN_URL", "https://github.com/org/repo/actions/runs/123")

    runpy.run_path(str(Path(notifications_module.__file__)), run_name="__main__")

    env_text = env_path.read_text(encoding="utf-8")
    assert "EMAIL_SUBJECT<<REGYBOX_EMAIL_SUBJECT_EOF" in env_text
    assert "Regybox Auto-enroll: success for WOD Rato on 2026-03-04 at 06:30" in env_text
    assert "EMAIL_BODY<<REGYBOX_EMAIL_BODY_EOF" in env_text


def test_notifications_main_sets_should_send_email_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for result, expected in [("success", "true"), ("failure", "true"), ("noop", "false")]:
        env_file = tmp_path / f"env_{result}"
        monkeypatch.setenv("GITHUB_ENV", str(env_file))
        monkeypatch.setenv("ENROLL_RESULT", result)
        monkeypatch.setenv("CLASS_TYPE", "WOD")
        monkeypatch.setenv("CLASS_DATE", "2026-03-04")
        monkeypatch.setenv("CLASS_TIME", "06:30")

        notifications_module.main()

        assert (
            f"SHOULD_SEND_EMAIL<<REGYBOX_SHOULD_SEND_EMAIL_EOF\n{expected}"
            in env_file.read_text(encoding="utf-8")
        )


def test_notifications_main_sends_marked_unenroll_reconciliation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / "env_unenroll_noop"
    monkeypatch.setenv("GITHUB_ENV", str(env_file))
    monkeypatch.setenv("ENROLL_RESULT", "noop")
    monkeypatch.setenv("REGYBOX_OPERATION", "unenroll")
    monkeypatch.setenv("NOTIFY_UNENROLL_NOOP", "true")
    monkeypatch.setenv("CLASS_TYPE", "WOD")
    monkeypatch.setenv("CLASS_DATE", "2026-03-04")
    monkeypatch.setenv("CLASS_TIME", "06:30")

    notifications_module.main()

    env_text = env_file.read_text(encoding="utf-8")
    assert "Regybox Auto-unenroll: already removed" in env_text
    assert "SHOULD_SEND_EMAIL<<REGYBOX_SHOULD_SEND_EMAIL_EOF\ntrue" in env_text


def test_read_kv_json_returns_empty_for_missing_value() -> None:
    with patch("regybox.notifications.requests.get") as get:
        response = get.return_value
        response.status_code = 404
        assert (
            read_kv_json(
                config=CloudflareKVConfig(
                    account_id="account",
                    namespace_id="namespace",
                    api_token=FAKE_CREDENTIAL,
                ),
                cache_key="regybox:v1:key",
            )
            == {}
        )


def test_read_kv_json_parses_existing_value() -> None:
    with patch("regybox.notifications.requests.get") as get:
        response = get.return_value
        response.status_code = 200
        response.text = '{"state": "not_open"}'
        assert read_kv_json(
            config=CloudflareKVConfig(
                account_id="account",
                namespace_id="namespace",
                api_token=FAKE_CREDENTIAL,
            ),
            cache_key="regybox:v1:key",
        ) == {"state": "not_open"}
        response.raise_for_status.assert_called_once_with()


def test_write_kv_json_sends_payload() -> None:
    with patch("regybox.notifications.requests.put") as put:
        response = put.return_value
        write_kv_json(
            config=CloudflareKVConfig(
                account_id="account",
                namespace_id="namespace",
                api_token=FAKE_CREDENTIAL,
            ),
            cache_key="regybox:v1:key",
            payload={"failureNotificationFingerprint": "failure:enroll:x:y"},
        )
        assert put.call_args.kwargs["params"] == {"expiration_ttl": str(KV_TTL_SECONDS)}
        assert (
            json.loads(put.call_args.kwargs["data"])["failureNotificationFingerprint"]
            == "failure:enroll:x:y"
        )
        response.raise_for_status.assert_called_once_with()


def test_notifications_main_suppresses_repeated_cached_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / "env_failure"
    log_path = tmp_path / "enroll.log"
    payload = {
        "error_code": "class_overbooked",
        "user_title": "Class and waitlist are full",
        "user_message": "No spots are available.",
        "technical_message": "Class is overbooked",
    }
    log_path.write_text(
        f"ERROR {REGYBOX_USER_ERROR_PREFIX}{json.dumps(payload)}",
        encoding="utf-8",
    )
    fingerprint = "failure:enroll:class_overbooked:Class and waitlist are full"

    monkeypatch.setenv("GITHUB_ENV", str(env_file))
    monkeypatch.setenv("ENROLL_RESULT", "failure")
    monkeypatch.setenv("CLASS_TYPE", "WOD")
    monkeypatch.setenv("CLASS_DATE", "2026-03-04")
    monkeypatch.setenv("CLASS_TIME", "06:30")
    monkeypatch.setenv("ENROLL_LOG_PATH", str(log_path))
    monkeypatch.setenv("CACHE_KEY", "regybox:v1:key")
    with (
        patch("regybox.notifications.CloudflareKVConfig.from_env"),
        patch(
            "regybox.notifications.read_kv_json",
            return_value={"failureNotificationFingerprint": fingerprint},
        ),
        patch("regybox.notifications.write_kv_json") as write_kv_json,
    ):
        notifications_module.main()

    assert "SHOULD_SEND_EMAIL<<REGYBOX_SHOULD_SEND_EMAIL_EOF\nfalse" in env_file.read_text(
        encoding="utf-8"
    )
    write_kv_json.assert_not_called()


def test_notifications_main_sends_changed_failure_without_caching_before_delivery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / "env_failure"
    log_path = tmp_path / "enroll.log"
    payload = {
        "error_code": "class_overbooked",
        "user_title": "Class and waitlist are full",
        "user_message": "No spots are available.",
        "technical_message": "Class is overbooked",
    }
    log_path.write_text(
        f"ERROR {REGYBOX_USER_ERROR_PREFIX}{json.dumps(payload)}",
        encoding="utf-8",
    )

    monkeypatch.setenv("GITHUB_ENV", str(env_file))
    monkeypatch.setenv("ENROLL_RESULT", "failure")
    monkeypatch.setenv("CLASS_TYPE", "WOD")
    monkeypatch.setenv("CLASS_DATE", "2026-03-04")
    monkeypatch.setenv("CLASS_TIME", "06:30")
    monkeypatch.setenv("ENROLL_LOG_PATH", str(log_path))
    monkeypatch.setenv("CACHE_KEY", "regybox:v1:key")
    with (
        patch("regybox.notifications.CloudflareKVConfig.from_env"),
        patch(
            "regybox.notifications.read_kv_json",
            return_value={"failureNotificationFingerprint": "failure:enroll:login_error:old"},
        ),
        patch("regybox.notifications.write_kv_json") as write_kv_json,
    ):
        notifications_module.main()

    assert "SHOULD_SEND_EMAIL<<REGYBOX_SHOULD_SEND_EMAIL_EOF\ntrue" in env_file.read_text(
        encoding="utf-8"
    )
    env_text = env_file.read_text(encoding="utf-8")
    assert (
        "FAILURE_NOTIFICATION_FINGERPRINT<<REGYBOX_FAILURE_NOTIFICATION_FINGERPRINT_EOF\n"
        "failure:enroll:class_overbooked:Class and waitlist are full" in env_text
    )
    write_kv_json.assert_not_called()


def test_record_delivered_failure_notification_caches_fingerprint() -> None:
    with (
        patch("regybox.notifications.CloudflareKVConfig.from_env") as from_env,
        patch(
            "regybox.notifications.read_kv_json",
            return_value={"state": "not_open"},
        ),
        patch("regybox.notifications.write_kv_json") as write_kv_json,
    ):
        record_delivered_failure_notification(
            cache_key="regybox:v1:key",
            fingerprint="failure:enroll:class_overbooked:Class and waitlist are full",
        )

    write_kv_json.assert_called_once_with(
        config=from_env.return_value,
        cache_key="regybox:v1:key",
        payload={
            "state": "not_open",
            "failureNotificationFingerprint": (
                "failure:enroll:class_overbooked:Class and waitlist are full"
            ),
        },
    )


def test_notifications_main_sends_when_kv_check_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / "env_failure"
    log_path = tmp_path / "enroll.log"
    log_path.write_text("ERROR requests.exceptions.Timeout: timed out", encoding="utf-8")

    monkeypatch.setenv("GITHUB_ENV", str(env_file))
    monkeypatch.setenv("ENROLL_RESULT", "failure")
    monkeypatch.setenv("CLASS_TYPE", "WOD")
    monkeypatch.setenv("CLASS_DATE", "2026-03-04")
    monkeypatch.setenv("CLASS_TIME", "06:30")
    monkeypatch.setenv("ENROLL_LOG_PATH", str(log_path))
    monkeypatch.setenv("CACHE_KEY", "regybox:v1:key")
    with patch("regybox.notifications.CloudflareKVConfig.from_env", side_effect=ValueError):
        notifications_module.main()

    assert "SHOULD_SEND_EMAIL<<REGYBOX_SHOULD_SEND_EMAIL_EOF\ntrue" in env_file.read_text(
        encoding="utf-8"
    )
