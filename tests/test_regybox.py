import logging
import tomllib
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import pytest
from hypothesis import given
from hypothesis.strategies import integers

from regybox import __version__
from regybox.exceptions import NoClassesFoundError
from regybox.regybox import LONG_WAIT, MED_WAIT, SHORT_WAIT, list_classes, snooze

from . import html_examples

if TYPE_CHECKING:
    import io


def test_version() -> None:
    file_: io.BufferedReader
    with Path("pyproject.toml").open("rb") as file_:
        project_meta: dict[str, Any] = tomllib.load(file_)

    assert __version__ == project_meta["project"]["version"]


def test_times() -> None:
    assert SHORT_WAIT < MED_WAIT
    assert MED_WAIT < LONG_WAIT


@given(time=integers())
def test_wait(time: int) -> None:
    assert snooze(time) >= SHORT_WAIT
    assert snooze(time) <= LONG_WAIT
    if time > SHORT_WAIT:
        assert snooze(time) < time


def test_list_classes(caplog: pytest.LogCaptureFixture) -> None:
    """Test list_classes outputs a properly formatted markdown table."""
    # Read HTML examples and combine them into a multi-class HTML
    open_html = resources.files(html_examples).joinpath("open.html").read_text()
    full_html = resources.files(html_examples).joinpath("full.html").read_text()
    registered_html = resources.files(html_examples).joinpath("registered.html").read_text()

    # Combine multiple classes into one HTML response
    combined_html = f"{open_html}\n{full_html}\n{registered_html}"

    with (
        caplog.at_level(logging.INFO),
        patch("regybox.classes.get_classes_html", return_value=combined_html),
    ):
        list_classes("2024-07-01")

    # Check that the output contains the expected table structure
    log_output = caplog.text
    assert "Classes for 2024-07-01:" in log_output
    assert "| Name" in log_output
    assert "| Details" in log_output
    assert "| Time" in log_output
    assert "| Capacity" in log_output
    assert "| Status" in log_output

    # Check that the table separator is present
    assert "|------" in log_output or "| -----" in log_output

    # Check that class data is present
    assert "WOD Rato" in log_output
    assert "Rato" in log_output or "Aul" in log_output  # Aulão might be fixed by ftfy

    # Verify the table has rows
    lines = log_output.split("\n")
    table_lines = [
        line
        for line in lines
        if line.startswith("|") and "Name" not in line and "---" not in line
    ]
    assert len(table_lines) > 0, "Table should have at least one data row"


def test_list_classes_no_classes(caplog: pytest.LogCaptureFixture) -> None:
    """Test the list_classes function when no classes are found."""
    with (
        caplog.at_level(logging.INFO),
        patch("regybox.classes.get_classes_html", return_value=""),
        pytest.raises(NoClassesFoundError),
    ):
        list_classes("2024-07-01")
