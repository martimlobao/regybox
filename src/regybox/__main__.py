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

import sys

from regybox.common import LOGGER
from regybox.exceptions import RegyboxBaseError
from regybox.regybox import main


def run() -> None:
    """Run the Regybox application."""
    try:
        class_date, class_time, class_type = sys.argv[1:]
    except ValueError:
        LOGGER.error("Usage: uv run regybox <class_date> <class_time> <class_type>")
        sys.exit(1)
    try:
        main(class_date=class_date, class_time=class_time, class_type=class_type)
    except RegyboxBaseError as e:
        LOGGER.error(e)
        sys.exit(1)


if __name__ == "__main__":
    run()
