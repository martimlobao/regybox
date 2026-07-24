import datetime
import logging
import tomllib
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import given
from hypothesis.strategies import integers

from regybox import __version__
from regybox.common import LOGGER
from regybox.exceptions import (
    ClassIsOverbookedError,
    ClassNotFoundError,
    ClassNotOpenError,
    NoClassesFoundError,
    RegyboxTimeoutError,
    UserAlreadyEnrolledError,
)
from regybox.regybox import (
    LONG_WAIT,
    MED_WAIT,
    SHORT_WAIT,
    OperationOptions,
    OperationResult,
    list_classes,
    main,
    parse_class_types,
    pick_first_class,
    snooze,
)
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
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )
    mock_class.enroll.assert_called_once()
    assert result == OperationResult(operation="enroll", status="success", class_type="WOD Rato")
    assert "Inscrito" in caplog.text or "Runtime:" in caplog.text
    assert "Attempting to enroll in WOD Rato on 2026-03-10 at 06:30" in caplog.text


def test_main_attempts_to_enroll_when_class_full_with_waitlist(
    caplog: pytest.LogCaptureFixture,
) -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = True
    mock_class.is_full = True
    mock_class.is_overbooked = False
    mock_class.enroll.return_value = "Lista de espera"
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )

    mock_class.enroll.assert_called_once()
    assert result == OperationResult(operation="enroll", status="success", class_type="WOD Rato")
    assert "WOD Rato on 2026-03-10 at 06:30 is full; attempting waitlist enrollment" in caplog.text


def test_main_raises_overbooked_when_class_and_waitlist_full() -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = True
    mock_class.is_full = True
    mock_class.is_overbooked = True
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
        pytest.raises(ClassIsOverbookedError),
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )

    mock_class.enroll.assert_not_called()


def test_main_raises_overbooked_when_closed_class_and_waitlist_full(
    caplog: pytest.LogCaptureFixture,
) -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = False
    mock_class.is_full = True
    mock_class.is_overbooked = True
    mock_class.time_to_enroll = None
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
        pytest.raises(ClassIsOverbookedError),
    ):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )

    mock_class.enroll.assert_not_called()
    assert "WOD Rato on 2026-03-10 at 06:30 is overbooked" in caplog.text


def test_main_noops_for_closed_error_span_when_class_is_not_full() -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = False
    mock_class.is_full = False
    mock_class.is_overbooked = False
    mock_class.enrollment_deadline_expired = True
    mock_class.time_to_enroll = None
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
            operation_options=OperationOptions(not_open_is_noop=True),
        )

    mock_class.enroll.assert_not_called()
    assert result == OperationResult(operation="enroll", status="noop", class_type="WOD Rato")


def test_main_raises_not_open_when_closed_error_span_class_is_not_full() -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = False
    mock_class.is_full = False
    mock_class.is_overbooked = False
    mock_class.enrollment_deadline_expired = True
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

    mock_class.enroll.assert_not_called()


def test_main_noops_when_already_enrolled_even_if_overbooked(
    caplog: pytest.LogCaptureFixture,
) -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = True
    mock_class.is_full = True
    mock_class.is_overbooked = True
    mock_class.user_is_enrolled = True
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )

    mock_class.enroll.assert_not_called()
    assert result == OperationResult(operation="enroll", status="noop", class_type="WOD Rato")
    assert "Already enrolled in class" in caplog.text


def test_parse_class_types_supports_comma_separated_candidates() -> None:
    assert parse_class_types(" WOD, Weekend WOD ,, Open Gym ") == [
        "WOD",
        "Weekend WOD",
        "Open Gym",
    ]


def test_pick_first_class_raises_last_candidate_error() -> None:
    with pytest.raises(ClassNotFoundError, match="Weekend WOD"):
        pick_first_class(
            [],
            class_time="06:30",
            class_types=["WOD", "Weekend WOD"],
            class_date="2026-03-10",
        )


def test_pick_first_class_rejects_empty_candidates() -> None:
    with pytest.raises(ClassNotFoundError):
        pick_first_class(
            [],
            class_time="06:30",
            class_types=[],
            class_date="2026-03-10",
        )


def test_main_rejects_empty_class_type() -> None:
    with pytest.raises(ValueError, match="class_type"):
        main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type=" , ",
            check_calendar=False,
        )


def test_main_tries_comma_separated_class_types_in_order() -> None:
    first_class: MagicMock = MagicMock()
    first_class.name = "Weekend WOD"
    first_class.start = "06:30"
    first_class.date = "2026-03-10"
    first_class.is_open = True
    first_class.enroll.return_value = "Inscrito"
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[first_class]),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD, Weekend WOD",
            check_calendar=False,
            timeout=60,
        )

    first_class.enroll.assert_called_once()
    assert result == OperationResult(
        operation="enroll",
        status="success",
        class_type="Weekend WOD",
    )


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
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
        )
    assert result == OperationResult(operation="enroll", status="noop", class_type="WOD Rato")
    assert "Already enrolled" in caplog.text


def test_main_treats_not_open_as_noop_when_requested() -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = False
    mock_class.time_to_enroll = 1000
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
            operation_options=OperationOptions(not_open_is_noop=True),
        )

    assert result == OperationResult(operation="enroll", status="noop", class_type="WOD Rato")


def test_main_retries_not_open_noop_when_enrollment_opens_within_timeout(
    caplog: pytest.LogCaptureFixture,
) -> None:
    closed_class: MagicMock = MagicMock()
    closed_class.name = "WOD Rato"
    closed_class.is_open = False
    closed_class.time_to_enroll = 90

    open_class: MagicMock = MagicMock()
    open_class.name = "WOD Rato"
    open_class.is_open = True
    open_class.user_is_enrolled = False

    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[closed_class]),
        patch("regybox.regybox.pick_class", side_effect=[closed_class, open_class]),
        patch("regybox.regybox.time.monotonic", side_effect=[0, 0, 60]),
        patch("regybox.regybox.time.sleep") as sleep_mock,
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=900,
            operation_options=OperationOptions(not_open_is_noop=True),
        )

    assert result == OperationResult(operation="enroll", status="success", class_type="WOD Rato")
    sleep_mock.assert_called_once_with(60)
    open_class.enroll.assert_called_once_with()
    structured_messages = [
        record.getMessage()
        for record in caplog.records
        if record.name == LOGGER.name and record.getMessage().startswith("REGYBOX_")
    ]
    assert structured_messages == ["REGYBOX_RESULT=success operation=enroll class_type=WOD Rato"]


def test_main_logs_not_open_cache_metadata_when_time_to_enroll_known(
    caplog: pytest.LogCaptureFixture,
) -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = False
    mock_class.time_to_enroll = 3600
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
            operation_options=OperationOptions(not_open_is_noop=True),
        )

    assert result == OperationResult(operation="enroll", status="noop", class_type="WOD Rato")
    assert "Enrollment is not open; opens in 1:00:00; returning no-op result" in caplog.text
    assert "REGYBOX_CACHE_STATE=not_open" in caplog.text
    assert "enrollment_opens_at=" in caplog.text
    assert "last_checked_at=" in caplog.text


def test_main_treats_not_open_without_timer_as_noop_when_requested() -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.is_open = False
    mock_class.time_to_enroll = None
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=60,
            operation_options=OperationOptions(not_open_is_noop=True),
        )

    assert result == OperationResult(operation="enroll", status="noop", class_type="WOD Rato")


def test_main_timeout_is_noop_when_requested() -> None:
    with patch("regybox.regybox.START", datetime.datetime.now(datetime.UTC)):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            timeout=0,
            operation_options=OperationOptions(not_open_is_noop=True),
        )

    assert result == OperationResult(operation="enroll", status="noop", class_type="WOD Rato")


def test_main_unenrolls_when_enrolled(caplog: pytest.LogCaptureFixture) -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.user_is_enrolled = True
    mock_class.unenroll.return_value = "Desmarcado"
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            operation_options=OperationOptions(operation="unenroll"),
        )

    mock_class.unenroll.assert_called_once()
    assert result == OperationResult(operation="unenroll", status="success", class_type="WOD Rato")
    assert "Attempting to unenroll from WOD Rato on 2026-03-10 at 06:30" in caplog.text


def test_main_unenroll_noops_when_not_enrolled() -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.user_is_enrolled = False
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            operation_options=OperationOptions(operation="unenroll"),
        )

    mock_class.unenroll.assert_not_called()
    assert result == OperationResult(operation="unenroll", status="noop", class_type="WOD Rato")


def test_main_unenroll_checks_later_fallback_when_first_match_is_not_enrolled() -> None:
    first_class: MagicMock = MagicMock()
    first_class.name = "WOD"
    first_class.user_is_enrolled = False
    second_class: MagicMock = MagicMock()
    second_class.name = "Weekend WOD"
    second_class.user_is_enrolled = True

    def pick_side_effect(
        classes: list[MagicMock], *, class_time: str, class_type: str, class_date: str
    ) -> MagicMock:
        _ = (classes, class_time, class_date)
        return {"WOD": first_class, "Weekend WOD": second_class}[class_type]

    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[first_class, second_class]),
        patch("regybox.regybox.pick_class", side_effect=pick_side_effect),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD, Weekend WOD",
            check_calendar=False,
            operation_options=OperationOptions(operation="unenroll"),
        )

    first_class.unenroll.assert_not_called()
    second_class.unenroll.assert_called_once()
    assert result == OperationResult(
        operation="unenroll", status="success", class_type="Weekend WOD"
    )


def test_main_unenroll_noops_when_class_is_missing() -> None:
    with (
        patch("regybox.regybox.check_cal"),
        patch("regybox.regybox.get_classes", return_value=[]),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=False,
            operation_options=OperationOptions(operation="unenroll"),
        )

    assert result == OperationResult(operation="unenroll", status="noop", class_type="WOD Rato")


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


def test_main_skips_calendar_check_for_unenroll() -> None:
    mock_class: MagicMock = MagicMock()
    mock_class.name = "WOD Rato"
    mock_class.user_is_enrolled = False
    with (
        patch("regybox.regybox.check_cal") as mock_check_cal,
        patch("regybox.regybox.get_classes", return_value=[mock_class]),
        patch("regybox.regybox.pick_class", return_value=mock_class),
    ):
        result = main(
            class_date="2026-03-10",
            class_time="06:30",
            class_type="WOD Rato",
            check_calendar=True,
            operation_options=OperationOptions(operation="unenroll"),
        )

    mock_check_cal.assert_not_called()
    assert result == OperationResult(operation="unenroll", status="noop", class_type="WOD Rato")


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


def test_main_calls_check_cal_with_whitespace_event_name_uses_default() -> None:
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
            event_name="   ",
            check_calendar=True,
            timeout=60,
        )

    assert mock_check_cal.call_args[1]["event_name"] == "CrossFit"


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
