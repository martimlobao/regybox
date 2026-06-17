"""The main entry point for the Regybox application.

This script is responsible for executing the Regybox application with the
provided command-line arguments. It imports the necessary modules, initializes
the logger, and calls the main function to enroll in a class with the specified
class date, class time, and class type.

Args:
    class_date (str): The date of the class.
    class_time (str): The time of the class.
    class_type (str): The type of the class.

Returns:
    None

Raises:
    RegyboxBaseError: If an expected error occurs during the execution of the
    main function.
"""

import argparse
import json
import sys

from regybox.common import LOGGER
from regybox.exceptions import REGYBOX_USER_ERROR_PREFIX, RegyboxBaseError
from regybox.regybox import list_classes, main
from regybox.sync import CloudflareKVStore, sync_calendar


def _log_user_error(error: RegyboxBaseError) -> None:
    """Log technical and user-facing payload details for known errors."""
    LOGGER.error(error)
    LOGGER.error(
        f"{REGYBOX_USER_ERROR_PREFIX}{json.dumps(error.to_user_payload(), ensure_ascii=True)}"
    )


def run() -> None:
    """Run the Regybox enrollment application."""
    parser = argparse.ArgumentParser(
        prog="regybox",
        description="Enroll in a Regybox class.",
    )
    parser.add_argument("class_date", help="Class date in YYYY-MM-DD format.")
    parser.add_argument("class_time", help="Class start time in HH:MM format.")
    parser.add_argument("class_type", help="Class type name.")
    parser.add_argument(
        "--calendar-event-name",
        default=None,
        help="Calendar event title to match. Defaults to CrossFit.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=900,
        help="Maximum number of seconds to wait for enrollment to open.",
    )
    args = parser.parse_args()
    if args.timeout_seconds <= 0:
        LOGGER.error("timeout-seconds must be a positive integer.")
        sys.exit(1)
    try:
        main(
            class_date=args.class_date,
            class_time=args.class_time,
            class_type=args.class_type,
            event_name=args.calendar_event_name,
            timeout=args.timeout_seconds,
        )
    except RegyboxBaseError as e:
        _log_user_error(e)
        sys.exit(1)


def run_list() -> None:
    """Run the list classes command."""
    try:
        class_date = sys.argv[1]
    except IndexError:
        LOGGER.error("Usage: uv run list <class_date>")
        sys.exit(1)
    try:
        list_classes(class_date=class_date)
    except RegyboxBaseError as e:
        _log_user_error(e)
        sys.exit(1)
    except ValueError as e:
        LOGGER.error(f"Invalid date format. Expected YYYY-MM-DD: {e}")
        sys.exit(1)


def run_sync() -> None:
    """Run calendar-driven Regybox sync."""
    parser = argparse.ArgumentParser(
        prog="regybox-sync",
        description="Sync Regybox enrollments with mapped calendar events.",
    )
    parser.add_argument(
        "--calendar-event-names",
        required=True,
        help=("Comma-separated calendar event titles to sync, e.g. 'CrossFit, Open Gym'."),
    )
    parser.add_argument(
        "--target-class-types",
        required=True,
        help=(
            "Comma-separated Regybox class names that matching calendar events may target, e.g."
            " 'WOD, Open Gym'."
        ),
    )
    parser.add_argument(
        "--lookahead-days",
        type=int,
        default=3,
        help="How many days ahead to inspect in the calendar and Regybox.",
    )
    parser.add_argument(
        "--enroll-window-minutes",
        type=int,
        default=30,
        help=(
            "Only enroll classes that are open or whose enrollment opens within this many minutes."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log planned changes without enrolling, unenrolling, or writing KV state.",
    )
    args = parser.parse_args()
    if args.lookahead_days <= 0:
        LOGGER.error("lookahead-days must be a positive integer.")
        sys.exit(1)
    if args.enroll_window_minutes <= 0:
        LOGGER.error("enroll-window-minutes must be a positive integer.")
        sys.exit(1)
    try:
        sync_calendar(
            store=CloudflareKVStore.from_env(),
            calendar_event_names=args.calendar_event_names,
            target_class_types=args.target_class_types,
            lookahead_days=args.lookahead_days,
            enroll_window_minutes=args.enroll_window_minutes,
            dry_run=args.dry_run,
        )
    except RegyboxBaseError as e:
        _log_user_error(e)
        sys.exit(1)
    except (TypeError, ValueError) as e:
        LOGGER.error(e)
        sys.exit(1)


if __name__ == "__main__":
    run()
