import datetime
import time

from regybox.classes import Class, get_classes, pick_class
from regybox.common import LOGGER, TIMEZONE
from regybox.utils.time import secs_to_str

START: datetime.datetime = datetime.datetime.now(TIMEZONE)
SHORT_WAIT: int = 1
MED_WAIT: int = 10
LONG_WAIT: int = 60


def snooze(time_left: int) -> int:
    if time_left <= MED_WAIT:
        return SHORT_WAIT
    if time_left <= LONG_WAIT:
        return MED_WAIT
    return LONG_WAIT


def main(
    *, class_date: str | None = None, class_time: str = "06:30", class_type: str = "WOD Rato"
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
        class_: Class = pick_class(
            classes,
            class_time=class_time,
            class_type=class_type,
            class_date=date.date().isoformat(),
        )
        if class_.is_open:
            break

        if class_.time_to_enroll is None:
            raise RuntimeError("Class is not available for enrollment")

        if class_.time_to_enroll > timeout:
            raise RuntimeError(
                f"Enrollment for {class_type} on {date.date().isoformat()} at {class_time} is in"
                f" {secs_to_str(class_.time_to_enroll)}, which is more than maximum of"
                f" {secs_to_str(timeout)}"
            )

        wait: int = snooze(class_.time_to_enroll)  # seconds between calls
        LOGGER.info(
            f"Waiting for {class_type} on {date.date().isoformat()} at {class_time} to be"
            f" available, ETA in {secs_to_str(class_.time_to_enroll)}. Retrying in {wait} seconds."
        )
        time.sleep(wait)
    else:
        raise RuntimeError(
            f"Timed out waiting for class {class_type} on {date.date().isoformat()} at"
            f" {class_time}, terminating."
        )
    class_.enroll()
    LOGGER.info(f"Runtime: {(datetime.datetime.now(TIMEZONE) - START).total_seconds():.3f}")
