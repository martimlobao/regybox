"""Provide common variables and configurations for the Regybox application.

This module defines common variables and configurations used throughout the
Regybox application. It also loads environment variables from a .env file.

Variables:
    LOGGER: The logger instance for the Regybox application.
    TIMEZONE: The timezone used for date and time calculations.
    REGYBOX_USER: The Regybox user, used to create the Regybox website cookie.
    PHPSESSID: The PHP session ID, used to create the Regybox website cookie.
    CALENDAR_URL: The URL of the calendar.

Note:
    The module loads environment variables from a .env file using the dotenv
    package.
"""

import logging
import os
from zoneinfo import ZoneInfo

from dotenv import find_dotenv, load_dotenv

load_dotenv(dotenv_path=find_dotenv(usecwd=True))

logging.basicConfig(
    format="%(asctime)s %(levelname)s [%(name)s] [%(filename)s:%(lineno)d] - %(message)s",
    level=logging.INFO,
)
LOGGER: logging.Logger = logging.getLogger("REGYBOX")

TIMEZONE: ZoneInfo = ZoneInfo("Europe/Lisbon")

REGYBOX_USER: str = os.environ["REGYBOX_USER"]
PHPSESSID: str = os.environ["PHPSESSID"]
CALENDAR_URL: str = os.environ.get("CALENDAR_URL", "")
