import datetime
from zoneinfo import ZoneInfo

import pytest

from regybox.cal import Calendar, check_cal
from regybox.common import TIMEZONE
from regybox.exceptions import UnplannedClassError


def test_check_cal() -> None:
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
