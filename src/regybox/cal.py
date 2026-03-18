"""Provide functionality to interact with a personal calendar.

This module defines the Calendar class, which is responsible for fetching and
parsing the calendar specified by CALENDAR_URL.
"""

import datetime
from typing import cast

import icalendar
import recurring_ical_events  # pyright: ignore[reportMissingTypeStubs]
import requests

from regybox.common import CALENDAR_URL, LOGGER
from regybox.exceptions import UnplannedClassError
from regybox.utils.singleton import Singleton


def _normalize_event_name(event_name: str | None) -> str | None:
    """Normalize calendar event names for exact, case-insensitive matching.

    Returns:
        The trimmed event name, or ``None`` when the input is missing or blank.
    """
    if event_name is None:
        return None
    normalized: str = event_name.strip()
    if not normalized:
        return None
    return normalized


class Calendar(metaclass=Singleton):
    """Represent a calendar specified by the .ics URL in CALENDAR_URL.

    The calendar is stored as an icalendar.Calendar object and provides methods
    to find events and intervals.
    """

    calendar: icalendar.Calendar | None = None

    def __init__(self) -> None:
        """Initialize a new instance of the Calendar class."""
        if not CALENDAR_URL:
            self.calendar = None
            return
        if not self.calendar:
            res: requests.models.Response = requests.get(CALENDAR_URL, timeout=10)
            res.raise_for_status()
            decoded = res.content.decode("utf-8", errors="replace")
            self.calendar = cast(
                "icalendar.Calendar",
                icalendar.Calendar.from_ical(decoded),
            )

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
        if not self.calendar:
            return None
        normalized_event_name: str | None = _normalize_event_name(event_name)
        events = cast(
            "list[icalendar.cal.Event]",
            recurring_ical_events.of(self.calendar).at(when),
        )
        for event in events:
            if (
                type(event["DTSTART"].dt) is datetime.date
                and type(when) is datetime.datetime
                and event["DTSTART"].dt != when.date()
            ):
                continue
            if type(event["DTSTART"].dt) is datetime.date and type(when) is datetime.datetime:
                continue
            if normalized_event_name and not event.get("SUMMARY"):
                continue
            summary: str | None = None
            if event.get("SUMMARY"):
                summary = _normalize_event_name(str(event["SUMMARY"]))
            if normalized_event_name is None or (
                summary is not None and summary.casefold() == normalized_event_name.casefold()
            ):
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
        if not self.calendar:
            return []
        return cast(
            "list[icalendar.cal.Event]",
            recurring_ical_events.of(self.calendar).between(start, end),
        )


def check_cal(
    date: datetime.date,
    time: datetime.time,
    event_name: str | None = None,
    class_type: str | None = None,
) -> bool:
    """Check if a calendar event exists at the specified date and time.

    Args:
        date: The date to check for the event.
        time: The time to check for the event.
        event_name: The name of the event to check.
        class_type: The Regybox class type expected at that slot.

    Returns:
        True if the event exists, False otherwise.

    Raises:
        UnplannedClassError: If the event does not exist at the specified date
        and time.
    """
    when: datetime.datetime = datetime.datetime.combine(date, time)
    if not Calendar().calendar:
        return True
    if not Calendar().find(when=when, event_name=event_name):
        normalized_event_name: str | None = _normalize_event_name(event_name)
        raise UnplannedClassError(
            class_type=class_type,
            event_name=normalized_event_name or "requested event",
            class_isotime=when.isoformat(),
        )
    return True
