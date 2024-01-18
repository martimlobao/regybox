import logging

import pytz

logging.basicConfig(
    format="%(asctime)s %(levelname)s [%(name)s] [%(filename)s:%(lineno)d] - %(message)s",
    level=logging.INFO,
)
LOGGER: logging.Logger = logging.getLogger("REGIBOX")
TIMEZONE: pytz.BaseTzInfo = pytz.timezone("Europe/Lisbon")
