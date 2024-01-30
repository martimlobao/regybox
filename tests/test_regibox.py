import tomllib
from pathlib import Path
from typing import TYPE_CHECKING, Any

from hypothesis import given
from hypothesis.strategies import integers

from regibox import __version__
from regibox.regibox import LONG_WAIT, MED_WAIT, SHORT_WAIT, snooze

if TYPE_CHECKING:
    import io


def test_version() -> None:
    file_: io.BufferedReader
    with Path("pyproject.toml").open("rb") as file_:
        project_meta: dict[str, Any] = tomllib.load(file_)

    assert __version__ == project_meta["tool"]["poetry"]["version"]


def test_times() -> None:
    assert SHORT_WAIT < MED_WAIT
    assert MED_WAIT < LONG_WAIT


@given(time=integers())
def test_wait(time: int) -> None:
    assert snooze(time) >= SHORT_WAIT
    assert snooze(time) <= LONG_WAIT
    if time > SHORT_WAIT:
        assert snooze(time) < time
