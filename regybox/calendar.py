import datetime

import icalendar
import recurring_ical_events
import requests

from regybox.common import CALENDAR_URL, EVENT_NAME, LOGGER
from regybox.exceptions import UnplannedClassError
from regybox.utils.singleton import Singleton


class Calendar(metaclass=Singleton):
    calendar: icalendar.Calendar | None = None

    def __init__(self) -> None:
        if not self.calendar:
            res: requests.models.Response = requests.get(CALENDAR_URL, timeout=10)
            res.raise_for_status()
            self.calendar = icalendar.Calendar.from_ical(res.content)

    def find(
        self,
        when: datetime.datetime | datetime.date,
        event_name: str | None = None,
    ) -> icalendar.cal.Event | None:
        events: list[icalendar.cal.Event] = recurring_ical_events.of(self.calendar).at(when)
        for event in events:
            if (
                type(event["DTSTART"].dt) is datetime.date
                and type(when) is datetime.datetime
                and event["DTSTART"].dt != when.date()
            ):
                continue
            if type(event["DTSTART"].dt) is datetime.date and type(when) is datetime.datetime:
                continue
            if not event_name or event["SUMMARY"] == event_name:
                LOGGER.debug(dict(event.sorted_items()))
                return event
        return None

    def interval(
        self,
        start: datetime.datetime | datetime.date,
        end: datetime.datetime | datetime.date,
    ) -> list[icalendar.cal.Event]:
        events: list[icalendar.cal.Event] = recurring_ical_events.of(self.calendar).between(
            start, end
        )
        return events


def check_cal(when: datetime.datetime | datetime.date, event_name: str = EVENT_NAME) -> bool:
    if not Calendar().find(when=when, event_name=event_name):
        raise UnplannedClassError(when.isoformat())
    return True
