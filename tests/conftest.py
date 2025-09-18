"""Test configuration for the Regybox package."""

from typing import Final

import pytest

CALENDAR_FIXTURE: Final[str] = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Regybox//Tests//EN
BEGIN:VTIMEZONE
TZID:Europe/Vaduz
BEGIN:STANDARD
DTSTART:20101031T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:20100328T030000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:test-event-1@example.com
DTSTAMP:20120201T000000Z
DTSTART;TZID=Europe/Vaduz:20120213T100000
DTEND;TZID=Europe/Vaduz:20120213T110000
SUMMARY:CrossFit
END:VEVENT
END:VCALENDAR
"""


class _StaticResponse:
    """Minimal response object used to stub `requests.get`."""

    def __init__(self, content: str) -> None:
        self.content = content.encode("utf-8")

    def raise_for_status(self) -> None:
        """Mirror the requests API without performing any checks."""


@pytest.fixture(autouse=True)
def regybox_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REGYBOX_USER", "test-user")
    monkeypatch.setenv("PHPSESSID", "test-session")
    monkeypatch.setenv("CALENDAR_URL", "https://calendar.local/regybox.ics")


def _mock_get(url: str, timeout: int = 10, **_: object) -> _StaticResponse:
    del url, timeout
    return _StaticResponse(CALENDAR_FIXTURE)


@pytest.fixture
def mock_requests_get(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("requests.get", _mock_get)
