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
CLASS_TIME: str = "06:30"
CLASS_TYPE: str = "WOD Rato"
EVENT_NAME: str = "Crossfit"

REGYBOX_USER: str = os.environ["REGYBOX_USER"]
PHPSESSID: str = os.environ["PHPSESSID"]
CALENDAR_URL: str = os.environ["CALENDAR_URL"]
