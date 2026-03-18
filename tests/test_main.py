"""Tests for the CLI entrypoints in regybox.__main__."""

import json
import logging
import sys
from unittest.mock import patch

import pytest

from regybox import __main__ as cli
from regybox.exceptions import REGYBOX_USER_ERROR_PREFIX, RegyboxLoginError


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
