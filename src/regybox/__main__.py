"""The main entry point for the Regybox application.

This script is responsible for executing the Regybox application with the
provided command-line arguments. It imports the necessary modules, initializes
the logger, and calls the main function to enroll in a class with the specified
class date, class time, and class type.

Args:
    class_date (str): The date of the class.
    class_time (str): The time of the class.
    class_type (str): The type of the class.

Raises:
    RegyboxBaseError: If an expected error occurs during the execution of the
    main function.

Returns:
    None
"""

import argparse
import sys

from regybox.common import LOGGER
from regybox.exceptions import RegyboxBaseError
from regybox.regybox import list_classes, main


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
            timeout=args.timeout_seconds,
        )
    except RegyboxBaseError as e:
        LOGGER.error(e)
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
        LOGGER.error(e)
        sys.exit(1)
    except ValueError as e:
        LOGGER.error(f"Invalid date format. Expected YYYY-MM-DD: {e}")
        sys.exit(1)


if __name__ == "__main__":
    run()
