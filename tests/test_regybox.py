import json
import logging
import sys
import tomllib
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import given
from hypothesis.strategies import integers

from regybox import __main__ as cli
from regybox import __version__
from regybox.exceptions import (
    REGYBOX_USER_ERROR_PREFIX,
    ClassNotOpenError,
    NoClassesFoundError,
    RegyboxLoginError,
    RegyboxTimeoutError,
    UserAlreadyEnrolledError,
)
from regybox.regybox import LONG_WAIT, MED_WAIT, SHORT_WAIT, list_classes, main, snooze
from regybox.utils.times import secs_to_str

from . import html_examples

if TYPE_CHECKING:
    import io


def test_secs_to_str() -> None:
    assert secs_to_str(0) == "0:00:00"
    assert secs_to_str(65) == "0:01:05"
    assert secs_to_str(3661) == "1:01:01"


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
    overbooked_html = resources.files(html_examples).joinpath("overbooked.html").read_text()
    unlimited_html = resources.files(html_examples).joinpath("unlimited.html").read_text()

    # Cover status branches: OPEN, FULL, ENROLLED, OVERBOOKED, unlimited
    combined_html = (
        f"{open_html}\n{full_html}\n{registered_html}\n{overbooked_html}\n{unlimited_html}"
    )

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
        event_name=None,
        timeout=12,
    )


def test_cli_run_calls_main_with_calendar_event_name(monkeypatch: pytest.MonkeyPatch) -> None:
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


def test_main_enrolls_when_class_open(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Main() enrolls when pick_class returns an open class."""
    mock_class: MagicMock = MagicMock()
    mock_class.is_open = True
    mock_class.enroll.return_value = "Inscrito"
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )
    mock_class.enroll.assert_called_once()
    assert "Inscrito" in caplog.text or "Runtime:" in caplog.text


def test_main_raises_class_not_open_when_time_to_enroll_none() -> None:
    """Main() raises ClassNotOpenError if not open and time_to_enroll None."""
    mock_class: MagicMock = MagicMock()
    mock_class.is_open = False
    mock_class.time_to_enroll = None
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
        pytest.raises(ClassNotOpenError),
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )


def test_main_raises_timeout_when_time_to_enroll_exceeds_timeout() -> None:
    """Main() raises RegyboxTimeoutError when time_to_enroll > timeout."""
    mock_class: MagicMock = MagicMock()
    mock_class.is_open = False
    mock_class.time_to_enroll = 1000
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
        pytest.raises(RegyboxTimeoutError) as exc_info,
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )
    assert "60" in str(exc_info.value)
    assert "1000" in str(exc_info.value) or "enroll" in str(exc_info.value).lower()


def test_main_logs_when_already_enrolled(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Main() catches UserAlreadyEnrolledError and logs."""
    mock_class: MagicMock = MagicMock()
    mock_class.is_open = True
    mock_class.enroll.side_effect = UserAlreadyEnrolledError
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )
    assert "Already enrolled" in caplog.text


def test_main_uses_today_plus_two_when_class_date_none(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Main() uses current date + 2 days when class_date is None."""
    mock_class: MagicMock = MagicMock()
    mock_class.is_open = True
    mock_class.enroll.return_value = "OK"
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        main(
            class_date=None,
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )
    mock_class.enroll.assert_called_once()


def test_main_calls_check_cal_when_check_calendar_true() -> None:
    """Main() uses CrossFit as the default calendar event name."""
    mock_class: MagicMock = MagicMock()
    mock_class.is_open = True
    mock_class.enroll.return_value = "OK"
    with (
        patch("regybox.regybox.check_cal") as mock_check_cal,
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=True,
            timeout=60,
        )
    mock_check_cal.assert_called_once()
    call_kw = mock_check_cal.call_args[1]
    assert call_kw["date"].isoformat() == "2026-03-10"
    assert call_kw["event_name"] == "CrossFit"
    assert call_kw["class_type"] == "WOD Rato"


def test_main_calls_check_cal_with_explicit_event_name() -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.is_open = True
    mock_class.enroll.return_value = "OK"
    with (
        patch("regybox.regybox.check_cal") as mock_check_cal,
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            event_name="Crossfit",
            check_calendar=True,
            timeout=60,
        )

    assert mock_check_cal.call_args[1]["event_name"] == "Crossfit"
    assert mock_check_cal.call_args[1]["class_type"] == "WOD Rato"


def test_main_waits_then_enrolls_when_class_opens_later(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Main() waits when class not open, then enrolls when it opens."""
    closed_class: MagicMock = MagicMock()
    closed_class.is_open = False
    closed_class.time_to_enroll = 5
    open_class: MagicMock = MagicMock()
    open_class.is_open = True
    open_class.enroll.return_value = "Inscrito"
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch(
            "regybox.regybox.get_classes",
            side_effect=[[closed_class], [open_class]],
        ),
        patch("regybox.regybox.pick_class", side_effect=[closed_class, open_class]),
        patch("regybox.regybox.time.sleep"),
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )
    open_class.enroll.assert_called_once()
    assert "Waiting for" in caplog.text or "Retrying" in caplog.text
