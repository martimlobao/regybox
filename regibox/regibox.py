import datetime
import time
from dataclasses import dataclass

from regibox.classes import Class, get_classes, pick_class
from regibox.common import LOGGER, TIMEZONE
from regibox.exceptions import ClassNotFoundError

START: datetime.datetime = datetime.datetime.now(TIMEZONE)


@dataclass
class WaitTime:
    inf_sec: int = 5
    sup_sec: int = 50
    slow: int = 9
    fast: int = 1

    @classmethod
    def get(cls, now_seconds: int) -> int:
        return cls.slow if cls.inf_sec < now_seconds < cls.sup_sec else cls.fast


def main(
    class_date: str | None = None, class_time: str = "12:00", class_type: str = "WOD RATO"
) -> None:
    class_time = class_time.zfill(5)  # needs leading zeros
    LOGGER.info(f"Started at {START.isoformat()}")
    if not class_date:
        date: datetime.datetime = datetime.datetime.now(TIMEZONE) + datetime.timedelta(days=2)
    else:
        date = datetime.datetime.strptime(class_date, "%Y-%m-%d").replace(tzinfo=TIMEZONE)
    timeout: int = 900  # try for 15 minutes

    while (datetime.datetime.now(TIMEZONE) - START).total_seconds() < timeout:
        classes: list[Class] = get_classes(date.year, date.month, date.day)
        try:
            class_: Class = pick_class(classes, class_time, class_type)
        except ClassNotFoundError:
            # seconds between calls
            wait: int = WaitTime.get(datetime.datetime.now(TIMEZONE).second)
            LOGGER.info(
                f"No button found for {class_type} on {date.date().isoformat()} at"
                f" {class_time}, retrying in {wait} seconds."
            )
            time.sleep(wait)
        else:
            break
    else:
        raise RuntimeError(
            f"Timed out waiting for class {class_type} on {date.date().isoformat()} at"
            f" {class_time}, terminating."
        )
    class_.enroll()
    LOGGER.info(f"Runtime: {(datetime.datetime.now(TIMEZONE) - START).total_seconds():.3f}")
