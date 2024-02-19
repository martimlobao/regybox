"""Provide functionality to interact with a personal calendar.

This module defines the Calendar class, which is responsible for fetching and
parsing the calendar specified by CALENDAR_URL.
"""

import datetime

import icalendar
import recurring_ical_events
import requests

from regybox.common import CALENDAR_URL, EVENT_NAME, LOGGER
from regybox.exceptions import UnplannedClassError
from regybox.utils.singleton import Singleton


class Calendar(metaclass=Singleton):
    """Represent a calendar specified by the .ics URL in CALENDAR_URL.

    The calendar is stored as an icalendar.Calendar object and provides methods
    to find events and intervals.
    """

    calendar: icalendar.Calendar | None = None

    def __init__(self) -> None:
        """Initialize a new instance of the Calendar class."""
        if not self.calendar:
            res: requests.models.Response = requests.get(CALENDAR_URL, timeout=10)
            res.raise_for_status()
            self.calendar = icalendar.Calendar.from_ical(res.content)

    def find(
        self,
        when: datetime.datetime | datetime.date,
        event_name: str | None = None,
    ) -> icalendar.cal.Event | None:
        """Find an event in the calendar with a given time and name.

        Args:
            when: The date or datetime to search for events.
            event_name: The name of the event to search for (case insensitive).
                If None, all events on the specified date will be considered.

        Returns:
            The first matching event found, or None if no event is found.
        """
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
            if not event_name or event["SUMMARY"].lower() == event_name.lower():
                LOGGER.debug(dict(event.sorted_items()))
                return event
        return None

    def interval(
        self,
        start: datetime.datetime | datetime.date,
        end: datetime.datetime | datetime.date,
    ) -> list[icalendar.cal.Event]:
        """Retrieve a list of events within the specified interval.

        Args:
            start: The start date or datetime of the interval.
            end: The end date or datetime of the interval.

        Returns:
            A list of events that fall within the specified interval.
        """
        events: list[icalendar.cal.Event] = recurring_ical_events.of(self.calendar).between(
            start, end
        )
        return events


def check_cal(when: datetime.datetime | datetime.date, event_name: str = EVENT_NAME) -> bool:
    """Check if a calendar event exists at the specified date and time.

    Args:
        when: The date and time to check for the event.
        event_name: The name of the event to check. Defaults to EVENT_NAME.

    Returns:
        True if the event exists, False otherwise.

    Raises:
        UnplannedClassError: If the event does not exist at the specified date
        and time.
    """
    if not Calendar().find(when=when, event_name=event_name):
        raise UnplannedClassError(when.isoformat())
    return True
