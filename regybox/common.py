import logging

import pytz

logging.basicConfig(
    format="%(asctime)s %(levelname)s [%(name)s] [%(filename)s:%(lineno)d] - %(message)s",
    level=logging.INFO,
)
LOGGER: logging.Logger = logging.getLogger("REGYBOX")
TIMEZONE: pytz.BaseTzInfo = pytz.timezone("Europe/Lisbon")
