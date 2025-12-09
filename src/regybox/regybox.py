"""Provide the main functionality for the Regybox application.

This module defines the main function, which is responsible for executing the
Regybox application. It retrieves the classes for a specified date, picks a
class based on criteria, and enrolls in the class.
"""

import datetime
import time

from regybox.cal import check_cal
from regybox.classes import Class, get_classes, pick_class
from regybox.common import CLASS_TIME, CLASS_TYPE, EVENT_NAME, LOGGER, TIMEZONE
from regybox.exceptions import ClassNotOpenError, RegyboxTimeoutError, UserAlreadyEnrolledError
from regybox.utils.times import secs_to_str

START: datetime.datetime = datetime.datetime.now(TIMEZONE)
SHORT_WAIT: int = 1
MED_WAIT: int = 10
LONG_WAIT: int = 60


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
    class_date: str | None = None,
    class_time: str = CLASS_TIME,
    class_type: str = CLASS_TYPE,
    check_calendar: bool = True,
) -> None:
    """Execute the main Regybox application.

    Args:
        class_date: The date of the class in the format 'YYYY-MM-DD'. If None,
            the current date plus 2 days will be used. Defaults to None.
        class_time: The time of the class in the format 'HH:MM'. Defaults to the
            value of CLASS_TIME.
        class_type: The type of class. Defaults to the value of CLASS_TYPE.
        check_calendar: Flag indicating whether to check a personal calendar for
            the existence of a planned class at the given date and time.
            Defaults to True.

    Raises:
        ClassNotOpenError: If the class is not open for enrollment.
        RegyboxTimeoutError: If the timeout is reached while waiting for the
            class to be available.
    """
    class_time = class_time.zfill(5)  # needs leading zeros
    LOGGER.info(f"Started at {START.isoformat()}")
    if not class_date:
        date: datetime.date = (datetime.datetime.now(TIMEZONE) + datetime.timedelta(days=2)).date()
    else:
        date = (datetime.datetime.strptime(class_date, "%Y-%m-%d").replace(tzinfo=TIMEZONE)).date()

    if check_calendar:
        check_cal(
            date=date,
            time=datetime.datetime.strptime(class_time, "%H:%M").replace(tzinfo=TIMEZONE).timetz(),
            event_name=EVENT_NAME,
        )

    timeout: int = 900  # try for 15 minutes
    while (datetime.datetime.now(TIMEZONE) - START).total_seconds() < timeout:
        classes: list[Class] = get_classes(date.year, date.month, date.day)
        class_: Class = pick_class(
            classes,
            class_time=class_time,
            class_type=class_type,
            class_date=date.isoformat(),
        )
        if class_.is_open:
            break

        if class_.time_to_enroll is None:
            raise ClassNotOpenError

        if class_.time_to_enroll > timeout:
            raise RegyboxTimeoutError(timeout, time_to_enroll=secs_to_str(class_.time_to_enroll))

        wait: int = snooze(class_.time_to_enroll)  # seconds between calls
        LOGGER.info(
            f"Waiting for {class_type} on {date.isoformat()} at {class_time} to be available, ETA"
            f" in {secs_to_str(class_.time_to_enroll)}. Retrying in {wait} seconds."
        )
        time.sleep(wait)
    else:
        raise RegyboxTimeoutError(timeout)
    try:
        class_.enroll()
    except UserAlreadyEnrolledError:
        LOGGER.info("Already enrolled in class")
    LOGGER.info(f"Runtime: {(datetime.datetime.now(TIMEZONE) - START).total_seconds():.3f}")


def list_classes(class_date: str) -> None:
    """List all classes for a specific date.

    Args:
        class_date: The date of the classes in the format 'YYYY-MM-DD'.
    """
    date = (datetime.datetime.strptime(class_date, "%Y-%m-%d").replace(tzinfo=TIMEZONE)).date()
    classes: list[Class] = get_classes(date.year, date.month, date.day)

    # Prepare data and calculate column widths
    table_data = []
    for class_ in classes:
        status_parts = []
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

    rows = []
    for name, details, time_range, capacity, status in table_data:
        rows.append(
            f"| {name:<{col_widths[0]}} | {details:<{col_widths[1]}} | "
            f"{time_range:<{col_widths[2]}} | {capacity:<{col_widths[3]}} | "
            f"{status:<{col_widths[4]}} |"
        )

    table_lines = [
        f"Classes for {class_date}:",
        "",
        header,
        separator,
        *rows,
    ]

    LOGGER.info("\n".join(table_lines))
