import datetime

import pytest

from regybox.calendar import Calendar, check_cal
from regybox.exceptions import UnplannedClassError


def test_check_cal() -> None:
    assert check_cal(datetime.date(2012, 2, 13), datetime.time(10, 0), event_name=None) == True
    with pytest.raises(UnplannedClassError):
        check_cal(datetime.date(2012, 2, 13), datetime.time(10, 0), event_name="foo")

    calendar = Calendar()
    assert calendar.find(when=datetime.datetime(2012, 2, 13, 10, 0), event_name=None) is not None
    assert calendar.find(when=datetime.datetime(2012, 2, 13, 10, 0), event_name="foo") == None
    assert (
        calendar.interval(
            datetime.datetime(2012, 2, 13, 10, 0), datetime.datetime(2012, 2, 13, 11, 0)
        )
        != []
    )
