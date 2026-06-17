"""Tests for the CLI entrypoints in regybox.__main__."""

import json
import logging
import sys
from unittest.mock import patch

import pytest

from regybox import __main__ as cli
from regybox.exceptions import REGYBOX_USER_ERROR_PREFIX, ClassNotOpenError, RegyboxLoginError


def test_run_calls_main_with_parsed_args(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["regybox", "2026-03-10", "06:30", "WOD Rato", "--timeout-seconds", "12"],
    )
    with patch("regybox.__main__.main") as mock_main:
        cli.run()

    mock_main.assert_called_once_with(
        class_date="2026-03-10",
        class_time="06:30",
        class_type="WOD Rato",
        event_name=None,
        timeout=12,
    )


def test_run_calls_main_with_calendar_event_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "regybox",
            "2026-03-10",
            "06:30",
            "WOD Rato",
            "--calendar-event-name",
            "Crossfit",
        ],
    )
    with patch("regybox.__main__.main") as mock_main:
        cli.run()

    mock_main.assert_called_once_with(
        class_date="2026-03-10",
        class_time="06:30",
        class_type="WOD Rato",
        event_name="Crossfit",
        timeout=900,
    )


def test_run_calls_main_with_whitespace_calendar_event_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "regybox",
            "2026-03-10",
            "06:30",
            "WOD Rato",
            "--calendar-event-name",
            "   ",
        ],
    )
    with patch("regybox.__main__.main") as mock_main:
        cli.run()

    mock_main.assert_called_once_with(
        class_date="2026-03-10",
        class_time="06:30",
        class_type="WOD Rato",
        event_name="   ",
        timeout=900,
    )


def test_run_exits_on_non_positive_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["regybox", "2026-03-10", "06:30", "WOD Rato", "--timeout-seconds", "0"],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.run()

    assert exc_info.value.code == 1


def test_run_exits_and_logs_payload_on_known_error(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["regybox", "2026-03-10", "06:30", "WOD Rato", "--timeout-seconds", "12"],
    )
    with (
        caplog.at_level(logging.ERROR),
        patch("regybox.__main__.main", side_effect=RegyboxLoginError()),
        pytest.raises(SystemExit) as exc_info,
    ):
        cli.run()

    assert exc_info.value.code == 1
    payload_line = next(
        line for line in caplog.text.splitlines() if REGYBOX_USER_ERROR_PREFIX in line
    )
    payload = json.loads(payload_line.split(REGYBOX_USER_ERROR_PREFIX, maxsplit=1)[1])
    assert payload["error_code"] == "login_error"
    assert payload["technical_message"] == "Unable to log in"


def test_run_list_exits_when_missing_date(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["list"])
    with pytest.raises(SystemExit) as exc_info:
        cli.run_list()

    assert exc_info.value.code == 1


def test_run_list_calls_list_classes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["list", "2026-03-10"])
    with patch("regybox.__main__.list_classes") as mock_list_classes:
        cli.run_list()

    mock_list_classes.assert_called_once_with(class_date="2026-03-10")


def test_run_list_exits_on_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """run_list exits with code 1 when list_classes raises ValueError."""
    monkeypatch.setattr(sys, "argv", ["list", "not-a-date"])
    with pytest.raises(SystemExit) as exc_info:
        cli.run_list()

    assert exc_info.value.code == 1


def test_run_sync_requires_calendar_event_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["regybox-sync"])

    with pytest.raises(SystemExit) as exc_info:
        cli.run_sync()

    assert exc_info.value.code == 2


def test_run_sync_requires_target_class_types(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["regybox-sync", "--calendar-event-names", "Crossfit"],
    )

    with pytest.raises(SystemExit) as exc_info:
        cli.run_sync()

    assert exc_info.value.code == 2


def test_run_sync_calls_sync_with_required_mapping_args(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "regybox-sync",
            "--calendar-event-names",
            "Crossfit",
            "--target-class-types",
            "WOD Rato",
        ],
    )
    with (
        patch("regybox.__main__.CloudflareKVStore.from_env") as store_from_env,
        patch("regybox.__main__.sync_calendar") as mock_sync_calendar,
    ):
        cli.run_sync()

    mock_sync_calendar.assert_called_once_with(
        store=store_from_env.return_value,
        calendar_event_names="Crossfit",
        target_class_types="WOD Rato",
        lookahead_days=3,
        enroll_window_minutes=30,
        dry_run=False,
    )


def test_run_sync_passes_custom_options(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "regybox-sync",
            "--calendar-event-names",
            "Crossfit, Open Gym",
            "--target-class-types",
            "WOD Rato, Weekend WOD Rato",
            "--lookahead-days",
            "4",
            "--enroll-window-minutes",
            "20",
            "--dry-run",
        ],
    )
    with (
        patch("regybox.__main__.CloudflareKVStore.from_env") as store_from_env,
        patch("regybox.__main__.sync_calendar") as mock_sync_calendar,
    ):
        cli.run_sync()

    mock_sync_calendar.assert_called_once_with(
        store=store_from_env.return_value,
        calendar_event_names="Crossfit, Open Gym",
        target_class_types="WOD Rato, Weekend WOD Rato",
        lookahead_days=4,
        enroll_window_minutes=20,
        dry_run=True,
    )


def test_run_sync_exits_on_invalid_window(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "regybox-sync",
            "--calendar-event-names",
            "Crossfit",
            "--target-class-types",
            "WOD Rato",
            "--enroll-window-minutes",
            "0",
        ],
    )

    with pytest.raises(SystemExit) as exc_info:
        cli.run_sync()

    assert exc_info.value.code == 1


def test_run_sync_exits_on_invalid_lookahead(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "regybox-sync",
            "--calendar-event-names",
            "Crossfit",
            "--target-class-types",
            "WOD Rato",
            "--lookahead-days",
            "0",
        ],
    )

    with pytest.raises(SystemExit) as exc_info:
        cli.run_sync()

    assert exc_info.value.code == 1


def test_run_sync_exits_on_known_regybox_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "regybox-sync",
            "--calendar-event-names",
            "Crossfit",
            "--target-class-types",
            "WOD Rato",
        ],
    )
    with (
        patch("regybox.__main__.CloudflareKVStore.from_env"),
        patch("regybox.__main__.sync_calendar", side_effect=ClassNotOpenError()),
        pytest.raises(SystemExit) as exc_info,
    ):
        cli.run_sync()

    assert exc_info.value.code == 1


def test_run_sync_exits_on_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "regybox-sync",
            "--calendar-event-names",
            "Crossfit",
            "--target-class-types",
            "WOD Rato",
        ],
    )
    with (
        patch("regybox.__main__.CloudflareKVStore.from_env"),
        patch("regybox.__main__.sync_calendar", side_effect=ValueError("bad mapping")),
        pytest.raises(SystemExit) as exc_info,
    ):
        cli.run_sync()

    assert exc_info.value.code == 1
