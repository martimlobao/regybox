import datetime
from zoneinfo import ZoneInfo

import pytest

from regybox.cal import Calendar, check_cal
from regybox.common import TIMEZONE
from regybox.exceptions import UnplannedClassError
from regybox.utils.singleton import Singleton


def test_check_cal(mock_requests_get: pytest.MonkeyPatch) -> None:  # noqa: ARG001
    assert check_cal(datetime.date(2012, 2, 13), datetime.time(10, 0)) is True
    with pytest.raises(UnplannedClassError):
        check_cal(datetime.date(2012, 2, 13), datetime.time(10, 0), event_name="foo")

    calendar = Calendar()
    timezone = ZoneInfo("Europe/Vaduz")
    assert calendar.find(when=datetime.datetime(2012, 2, 13, 10, 0, tzinfo=timezone)) is not None
    assert calendar.find(when=datetime.datetime(2012, 2, 13, 9, 0, tzinfo=timezone)) is None
    assert calendar.find(when=datetime.datetime(2012, 2, 13, 10, 0, tzinfo=TIMEZONE)) is None
    assert calendar.find(when=datetime.datetime(2012, 2, 13, 9, 0, tzinfo=TIMEZONE)) is not None
    assert (
        calendar.find(
            when=datetime.datetime(2012, 2, 13, 10, 0, tzinfo=timezone), event_name="foo"
        )
        is None
    )
    assert (
        calendar.interval(
            datetime.datetime(2012, 2, 13, 10, 0, tzinfo=timezone),
            datetime.datetime(2012, 2, 13, 11, 0, tzinfo=timezone),
        )
        != []
    )


def test_check_cal_returns_true_when_no_calendar_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """check_cal returns True when CALENDAR_URL is unset."""
    monkeypatch.setattr("regybox.cal.CALENDAR_URL", "")
    if Calendar in Singleton._instances:
        del Singleton._instances[Calendar]
    try:
        assert check_cal(datetime.date(2012, 2, 13), datetime.time(10, 0)) is True
    finally:
        if Calendar in Singleton._instances:
            del Singleton._instances[Calendar]
