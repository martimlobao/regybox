"""Provide the main functionality for the Regybox application.

This module defines the main function, which is responsible for executing the
Regybox application. It retrieves the classes for a specified date, picks a
class based on criteria, and enrolls in the class.
"""

import datetime
import time
from dataclasses import dataclass
from typing import Literal

from regybox.cal import check_cal
from regybox.classes import Class, get_classes, pick_class
from regybox.common import LOGGER, TIMEZONE
from regybox.exceptions import (
    ClassNotFoundError,
    ClassNotOpenError,
    RegyboxTimeoutError,
    UserAlreadyEnrolledError,
)
from regybox.utils.times import secs_to_str

START: datetime.datetime = datetime.datetime.now(TIMEZONE)
DEFAULT_CALENDAR_EVENT_NAME: str = "CrossFit"
SHORT_WAIT: int = 1
MED_WAIT: int = 10
LONG_WAIT: int = 60
OperationName = Literal["enroll", "unenroll"]
OperationStatus = Literal["success", "noop"]


@dataclass(frozen=True)
class OperationResult:
    """Result of one enrollment operation."""

    operation: OperationName
    status: OperationStatus
    class_type: str


@dataclass(frozen=True)
class OperationOptions:
    """Options controlling the requested class operation."""

    operation: OperationName = "enroll"
    not_open_is_noop: bool = False


def parse_class_types(class_type: str) -> list[str]:
    """Split a comma-separated class type input into ordered candidates.

    Returns:
        Ordered non-empty class type names.
    """
    return [part.strip() for part in class_type.split(",") if part.strip()]


def pick_first_class(
    classes: list[Class], *, class_time: str, class_types: list[str], class_date: str
) -> Class:
    """Pick the first matching class from ordered class type candidates.

    Returns:
        The first matching Regybox class.

    Raises:
        ClassNotFoundError: If none of the candidates match.
    """
    last_error: ClassNotFoundError | None = None
    for candidate in class_types:
        try:
            return pick_class(
                classes,
                class_time=class_time,
                class_type=candidate,
                class_date=class_date,
            )
        except ClassNotFoundError as e:
            last_error = e
    if last_error is not None:
        raise last_error
    raise ClassNotFoundError(class_type="", class_time=class_time, class_date=class_date)


def _operation_result(
    *, operation: OperationName, status: OperationStatus, class_type: str
) -> OperationResult:
    LOGGER.info(f"REGYBOX_RESULT={status} operation={operation} class_type={class_type}")
    return OperationResult(operation=operation, status=status, class_type=class_type)


def _unenroll_class(class_: Class, resolved_class_type: str) -> OperationResult:
    if not class_.user_is_enrolled:
        LOGGER.info("Already unenrolled from class")
        return _operation_result(
            operation="unenroll",
            status="noop",
            class_type=resolved_class_type,
        )
    class_.unenroll()
    return _operation_result(
        operation="unenroll",
        status="success",
        class_type=resolved_class_type,
    )


def _closed_enrollment_result(
    *, options: OperationOptions, resolved_class_type: str
) -> OperationResult | None:
    if not options.not_open_is_noop:
        return None
    LOGGER.info("Enrollment is not open; returning no-op result")
    return _operation_result(
        operation="enroll",
        status="noop",
        class_type=resolved_class_type,
    )


def _resolved_class_type(class_: Class, fallback: str) -> str:
    raw_name = getattr(class_, "name", fallback)
    return raw_name if isinstance(raw_name, str) else fallback


def _pick_requested_class(
    *,
    date: datetime.date,
    class_time: str,
    class_types: list[str],
    options: OperationOptions,
) -> Class | OperationResult:
    classes: list[Class] = get_classes(date.year, date.month, date.day)
    try:
        return pick_first_class(
            classes,
            class_time=class_time,
            class_types=class_types,
            class_date=date.isoformat(),
        )
    except ClassNotFoundError:
        if options.operation == "unenroll":
            LOGGER.info("Class not found for unenroll; treating as no-op")
            return _operation_result(
                operation="unenroll",
                status="noop",
                class_type=class_types[0],
            )
        raise


def _wait_for_enrollable_class(
    *,
    date: datetime.date,
    class_time: str,
    class_types: list[str],
    timeout: int,
    options: OperationOptions,
) -> Class | OperationResult:
    while (datetime.datetime.now(TIMEZONE) - START).total_seconds() < timeout:
        picked = _pick_requested_class(
            date=date,
            class_time=class_time,
            class_types=class_types,
            options=options,
        )
        if isinstance(picked, OperationResult):
            return picked
        resolved_class_type = _resolved_class_type(picked, class_types[0])
        if picked.is_open:
            return picked
        closed_result = _closed_enrollment_result(
            options=options,
            resolved_class_type=resolved_class_type,
        )
        if closed_result is not None:
            return closed_result
        if picked.time_to_enroll is None:
            raise ClassNotOpenError
        if picked.time_to_enroll > timeout:
            raise RegyboxTimeoutError(timeout, time_to_enroll=secs_to_str(picked.time_to_enroll))

        wait: int = snooze(picked.time_to_enroll)
        LOGGER.info(
            f"Waiting for {resolved_class_type} on {date.isoformat()} at {class_time} to be"
            f" available, ETA in {secs_to_str(picked.time_to_enroll)}. Retrying in {wait} seconds."
        )
        time.sleep(wait)
    if options.not_open_is_noop:
        LOGGER.info("Enrollment did not open before timeout; returning no-op result")
        return _operation_result(
            operation="enroll",
            status="noop",
            class_type=class_types[0],
        )
    raise RegyboxTimeoutError(timeout)


def snooze(time_left: int) -> int:
    """Helper function to determine the wait time between calls.

    Args:
        time_left: The time remaining in seconds.

    Returns:
        int: The duration to wait in seconds.
    """
    if time_left <= MED_WAIT:
        return SHORT_WAIT
    if time_left <= LONG_WAIT:
        return MED_WAIT
    return LONG_WAIT


def main(
    *,
    class_time: str,
    class_type: str,
    class_date: str | None = None,
    event_name: str = DEFAULT_CALENDAR_EVENT_NAME,
    check_calendar: bool = True,
    timeout: int = 900,
    operation_options: OperationOptions | None = None,
) -> OperationResult:
    """Execute the main Regybox application.

    Args:
        class_time: The time of the class in the format 'HH:MM'.
        class_type: The type of class.
        class_date: The date of the class in the format 'YYYY-MM-DD'. If None,
            the current date plus 2 days will be used.
        event_name: Optional calendar event name override. If omitted,
            'CrossFit' is used for calendar matching.
        check_calendar: Whether to check a personal calendar for a planned
            class at the given date and time.
            Defaults to True.
        timeout: Maximum number of seconds to wait for enrollment to open.
            Defaults to 900 seconds (15 minutes).
        operation_options: Options for enroll or unenroll behavior.

    Returns:
        The operation result.

    Raises:
        ValueError: If the class type input is empty.
    """
    options = operation_options or OperationOptions()
    class_time = class_time.zfill(5)  # needs leading zeros
    class_types: list[str] = parse_class_types(class_type)
    if not class_types:
        raise ValueError("class_type must include at least one class name.")
    LOGGER.info(f"Started at {START.isoformat()}")
    if not class_date:
        date: datetime.date = (datetime.datetime.now(TIMEZONE) + datetime.timedelta(days=2)).date()
    else:
        date = (datetime.datetime.strptime(class_date, "%Y-%m-%d").replace(tzinfo=TIMEZONE)).date()

    if check_calendar:
        calendar_event_name: str = (
            event_name.strip()
            if event_name and event_name.strip()
            else DEFAULT_CALENDAR_EVENT_NAME
        )
        check_cal(
            date=date,
            time=datetime.datetime.strptime(class_time, "%H:%M").replace(tzinfo=TIMEZONE).timetz(),
            event_name=calendar_event_name,
            class_type=class_types[0],
        )

    if options.operation == "unenroll":
        picked = _pick_requested_class(
            date=date,
            class_time=class_time,
            class_types=class_types,
            options=options,
        )
        if isinstance(picked, OperationResult):
            return picked
        return _unenroll_class(picked, _resolved_class_type(picked, class_types[0]))

    picked = _wait_for_enrollable_class(
        date=date,
        class_time=class_time,
        class_types=class_types,
        timeout=timeout,
        options=options,
    )
    if isinstance(picked, OperationResult):
        return picked
    class_ = picked
    resolved_class_type = _resolved_class_type(class_, class_types[0])
    try:
        class_.enroll()
    except UserAlreadyEnrolledError:
        LOGGER.info("Already enrolled in class")
        return _operation_result(
            operation="enroll",
            status="noop",
            class_type=resolved_class_type,
        )
    LOGGER.info(f"Runtime: {(datetime.datetime.now(TIMEZONE) - START).total_seconds():.3f}")
    return _operation_result(
        operation="enroll",
        status="success",
        class_type=resolved_class_type,
    )


def list_classes(class_date: str) -> None:
    """List all classes for a specific date.

    Args:
        class_date: The date of the classes in the format 'YYYY-MM-DD'.
    """
    date = (datetime.datetime.strptime(class_date, "%Y-%m-%d").replace(tzinfo=TIMEZONE)).date()
    classes: list[Class] = get_classes(date.year, date.month, date.day)

    # Prepare data and calculate column widths
    table_data: list[tuple[str, str, str, str, str]] = []
    for class_ in classes:
        status_parts: list[str] = []
        if class_.is_open:
            status_parts.append("OPEN")
        if class_.is_full:
            status_parts.append("FULL")
        if class_.is_overbooked:
            status_parts.append("OVERBOOKED")
        if class_.is_over:
            status_parts.append("OVER")
        if class_.user_is_enrolled:
            status_parts.append("ENROLLED")
        if class_.user_is_waitlisted:
            status_parts.append("WAITLISTED")
        if class_.user_is_blocked:
            status_parts.append("BLOCKED")

        status = ", ".join(status_parts) if status_parts else "-"
        capacity = (
            f"{class_.cur_capacity}/{class_.max_capacity}"
            if class_.max_capacity is not None
            else f"{class_.cur_capacity}/∞"
        )
        time_range = f"{class_.start}-{class_.end}"

        table_data.append((class_.name, class_.details, time_range, capacity, status))

    # Calculate max width for each column
    if not table_data:
        LOGGER.info(f"Classes for {class_date}: No classes found.")
        return

    col_widths = [
        max(len("Name"), *(len(row[0]) for row in table_data)),
        max(len("Details"), *(len(row[1]) for row in table_data)),
        max(len("Time"), *(len(row[2]) for row in table_data)),
        max(len("Capacity"), *(len(row[3]) for row in table_data)),
        max(len("Status"), *(len(row[4]) for row in table_data)),
    ]

    # Build markdown table with fixed column widths
    header = (
        f"| {'Name':<{col_widths[0]}} | {'Details':<{col_widths[1]}} | "
        f"{'Time':<{col_widths[2]}} | {'Capacity':<{col_widths[3]}} | "
        f"{'Status':<{col_widths[4]}} |"
    )
    separator = (
        f"| {'-' * col_widths[0]} | {'-' * col_widths[1]} | "
        f"{'-' * col_widths[2]} | {'-' * col_widths[3]} | "
        f"{'-' * col_widths[4]} |"
    )

    rows: list[str] = []
    for name, details, time_range, capacity, status in table_data:
        rows.append(
            f"| {name:<{col_widths[0]}} | {details:<{col_widths[1]}} | "
            f"{time_range:<{col_widths[2]}} | {capacity:<{col_widths[3]}} | "
            f"{status:<{col_widths[4]}} |"
        )

    table_lines: list[str] = [
        f"Classes for {class_date}:",
        "",
        header,
        separator,
        *rows,
    ]

    LOGGER.info("\n".join(table_lines))
