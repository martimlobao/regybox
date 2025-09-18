"""Test configuration for the Regybox package."""

from typing import Final

import pytest

# taken from https://raw.githubusercontent.com/collective/icalendar/v5.0.11/src/icalendar/tests/calendars/timezone_rdate.ics
CALENDAR_FIXTURE: Final[str] = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Regybox//Tests//EN
BEGIN:VTIMEZONE
TZID:posix/Europe/Vaduz
BEGIN:STANDARD
TZNAME:CET
TZOFFSETFROM:+002946
TZOFFSETTO:+0100
DTSTART:19011213T211538
RDATE;VALUE=DATE-TIME:19011213T211538
END:STANDARD
BEGIN:DAYLIGHT
TZNAME:CEST
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
DTSTART:19810329T020000
RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
BEGIN:DAYLIGHT
TZNAME:CEST
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
DTSTART:19410505T010000
RDATE;VALUE=DATE-TIME:19410505T010000
RDATE;VALUE=DATE-TIME:19420504T010000
END:DAYLIGHT
BEGIN:STANDARD
TZNAME:CET
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
DTSTART:19810927T030000
RRULE:FREQ=YEARLY;COUNT=15;BYDAY=-1SU;BYMONTH=9
END:STANDARD
BEGIN:STANDARD
TZNAME:CET
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
DTSTART:19961027T030000
RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:STANDARD
TZNAME:CET
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
DTSTART:19411006T020000
RDATE;VALUE=DATE-TIME:19411006T020000
RDATE;VALUE=DATE-TIME:19421005T020000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:test-event-1@example.com
DTSTAMP:20120201T000000Z
DTSTART;TZID=Europe/Vaduz:20120213T100000
DTEND;TZID=Europe/Vaduz:20120213T110000
SUMMARY:CrossFit
END:VEVENT
BEGIN:VEVENT
UID:123
DTSTART;TZID=posix/Europe/Vaduz:20120213T100000
SUMMARY=testevent
END:VEVENT
END:VCALENDAR
"""

@pytest.fixture(autouse=True)
def _set_required_env_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REGYBOX_USER", "test-user")
    monkeypatch.setenv("PHPSESSID", "test-session")
    monkeypatch.setenv("CALENDAR_URL", "https://calendar.local/regybox.ics")

class _StaticResponse:
    """Minimal response object used to stub `requests.get`."""

    def __init__(self, content: str) -> None:
        self.content = content.encode("utf-8")

    def raise_for_status(self) -> None:
        """Mirror the requests API without performing any checks."""


def _mock_get(url: str, timeout: int = 10, **_: object) -> _StaticResponse:
    del url, timeout
    return _StaticResponse(CALENDAR_FIXTURE)


@pytest.fixture
def mock_requests_get(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("requests.get", _mock_get)
