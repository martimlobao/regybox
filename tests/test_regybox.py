import json
import logging
import sys
import tomllib
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import pytest
from hypothesis import given
from hypothesis.strategies import integers

from regybox import __main__ as cli
from regybox import __version__
from regybox.exceptions import REGYBOX_USER_ERROR_PREFIX, NoClassesFoundError, RegyboxLoginError
from regybox.regybox import LONG_WAIT, MED_WAIT, SHORT_WAIT, list_classes, snooze

from . import html_examples

if TYPE_CHECKING:
    import io


def test_version() -> None:
    file_: io.BufferedReader
    with Path("pyproject.toml").open("rb") as file_:
        project_meta: dict[str, Any] = tomllib.load(file_)

    assert __version__ == project_meta["project"]["version"]


def test_times() -> None:
    assert SHORT_WAIT < MED_WAIT
    assert MED_WAIT < LONG_WAIT


@given(time=integers())
def test_wait(time: int) -> None:
    assert snooze(time) >= SHORT_WAIT
    assert snooze(time) <= LONG_WAIT
    if time > SHORT_WAIT:
        assert snooze(time) < time


def test_list_classes(caplog: pytest.LogCaptureFixture) -> None:
    """Test list_classes outputs a properly formatted markdown table."""
    # Read HTML examples and combine them into a multi-class HTML
    open_html = resources.files(html_examples).joinpath("open.html").read_text()
    full_html = resources.files(html_examples).joinpath("full.html").read_text()
    registered_html = resources.files(html_examples).joinpath("registered.html").read_text()

    # Combine multiple classes into one HTML response
    combined_html = f"{open_html}\n{full_html}\n{registered_html}"

    with (
        caplog.at_level(logging.INFO),
        patch("regybox.classes.get_classes_html", return_value=combined_html),
    ):
        list_classes("2024-07-01")

    # Check that the output contains the expected table structure
    log_output = caplog.text
    assert "Classes for 2024-07-01:" in log_output
    assert "| Name" in log_output
    assert "| Details" in log_output
    assert "| Time" in log_output
    assert "| Capacity" in log_output
    assert "| Status" in log_output

    # Check that the table separator is present
    assert "|------" in log_output or "| -----" in log_output

    # Check that class data is present
    assert "WOD Rato" in log_output
    assert "Rato" in log_output or "Aul" in log_output  # Aulão might be fixed by ftfy

    # Verify the table has rows
    lines = log_output.split("\n")
    table_lines = [
        line for line in lines if line.startswith("|") and "Name" not in line and "---" not in line
    ]
    assert len(table_lines) > 0, "Table should have at least one data row"


def test_list_classes_no_classes(caplog: pytest.LogCaptureFixture) -> None:
    """Test the list_classes function when no classes are found."""
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.classes.get_classes_html", return_value=""),
        pytest.raises(NoClassesFoundError),
    ):
        list_classes("2024-07-01")


def test_cli_run_calls_main_with_parsed_args(monkeypatch: pytest.MonkeyPatch) -> None:
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
        timeout=12,
    )


def test_cli_run_exits_on_non_positive_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["regybox", "2026-03-10", "06:30", "WOD Rato", "--timeout-seconds", "0"],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.run()

    assert exc_info.value.code == 1


def test_cli_run_exits_and_logs_payload_on_known_error(
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


def test_cli_run_list_exits_when_missing_date(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["list"])
    with pytest.raises(SystemExit) as exc_info:
        cli.run_list()

    assert exc_info.value.code == 1


def test_cli_run_list_calls_list_classes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["list", "2026-03-10"])
    with patch("regybox.__main__.list_classes") as mock_list_classes:
        cli.run_list()

    mock_list_classes.assert_called_once_with(class_date="2026-03-10")


def test_cli_run_list_exits_on_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["list", "not-a-date"])
    with (
        patch("regybox.__main__.list_classes", side_effect=ValueError("bad date")),
        pytest.raises(SystemExit) as exc_info,
    ):
        cli.run_list()

    assert exc_info.value.code == 1
