from importlib import resources

import pytest
from bs4 import BeautifulSoup
from bs4.element import PageElement, Tag

from regybox.classes import Class
from regybox.exceptions import UnparseableError
from tests.html_examples import __package__ as html_package


def extract_class(filename: str) -> Class:
    html: str = resources.files(html_package).joinpath(filename).read_text()
    if not html:
        raise FileNotFoundError(f"HTML file {filename} is empty")
    element: PageElement = BeautifulSoup(html, "html.parser").contents[0]
    if not isinstance(element, Tag):
        raise TypeError(f"HTML in {filename} resolved to {type(element)}, expected Tag")
    return Class(element)


def test_bad_html() -> None:
    with pytest.raises(UnparseableError):
        extract_class("bad_class.html")


def test_finished() -> None:
    class_: Class = extract_class("finished.html")
    assert class_.is_open is False
    assert class_.is_full is False
    assert class_.is_overbooked is False
    assert class_.is_over is True
    assert class_.user_is_blocked is True
    assert class_.user_is_enrolled is False
    assert class_.user_is_waitlisted is False
    assert class_.time_to_start is None
    assert class_.time_to_enroll is None
    assert class_.enroll_url is None
    assert class_.unenroll_url is None


def test_open() -> None:
    class_: Class = extract_class("open.html")
    assert class_.is_open is True
    # class_.is_full may be True or False
    assert class_.is_overbooked is False
    assert class_.is_over is False
    assert class_.user_is_blocked is False
    assert class_.user_is_enrolled is False
    assert class_.user_is_waitlisted is False
    assert class_.time_to_start is not None
    assert class_.time_to_start > 0
    assert class_.time_to_enroll is None
    assert bool(class_.enroll_url)
    assert class_.unenroll_url is None


def test_registered() -> None:
    class_: Class = extract_class("registered.html")
    assert class_.is_open is True
    # class_.is_full may be True or False
    # class_.is_overbooked may be True or False
    assert class_.is_over is False
    assert class_.user_is_blocked is False
    assert class_.user_is_enrolled is True
    assert class_.user_is_waitlisted is False
    assert class_.time_to_start is None  # timer to start disappears when user is enrolled
    assert class_.time_to_enroll is None
    assert class_.enroll_url is None
    assert bool(class_.unenroll_url)


def test_in_progress() -> None:
    class_: Class = extract_class("in_progress.html")
    assert class_.is_open is False
    # class_.is_full may be True or False
    # class_.is_overbooked may be True or False
    assert class_.is_over is False
    # class_.user_is_blocked may be True or False
    # class_.user_is_enrolled may be True or False
    # class_.user_is_waitlisted may be True or False
    assert class_.time_to_start is None
    assert class_.time_to_enroll is None
    assert class_.enroll_url is None
    assert class_.unenroll_url is None


def test_unenroll_closed() -> None:
    class_: Class = extract_class("unenroll_closed.html")
    assert class_.is_open is False
    # class_.is_full may be True or False
    # class_.is_overbooked may be True or False
    assert class_.is_over is False
    assert class_.user_is_blocked is False
    assert class_.user_is_enrolled is True
    # class_.user_is_waitlisted may be True or False
    assert class_.time_to_start is None  # timer to start disappears when user is enrolled
    assert class_.time_to_enroll is None
    assert class_.enroll_url is None
    assert class_.unenroll_url is None


def test_closed_starting_soon() -> None:
    class_: Class = extract_class("closed_starting_soon.html")
    assert class_.is_open is False
    # class_.is_full may be True or False
    # class_.is_overbooked may be True or False
    assert class_.is_over is False
    # class_.user_is_blocked may be True or False
    # class_.user_is_enrolled may be True or False
    # class_.user_is_waitlisted may be True or False
    assert class_.time_to_start is None  # timer to start disappears when class is about to start
    assert class_.time_to_enroll is None
    assert class_.enroll_url is None
    assert class_.unenroll_url is None


def test_full() -> None:
    with pytest.raises(FileNotFoundError):
        extract_class("full.html")


def test_overbooked() -> None:
    with pytest.raises(FileNotFoundError):
        extract_class("overbooked.html")


def test_registered_for_other() -> None:
    class_: Class = extract_class("registered_for_other.html")
    assert class_.is_open is True
    # class_.is_full may be True or False
    assert class_.is_overbooked is False
    assert class_.is_over is False
    assert class_.user_is_blocked is True
    assert class_.user_is_enrolled is False
    assert class_.user_is_waitlisted is False
    assert class_.time_to_start is None  # timer to start disappears when user is blocked
    assert class_.time_to_enroll is None
    assert class_.enroll_url is None
    assert class_.unenroll_url is None


def test_waitlisted() -> None:
    class_: Class = extract_class("waitlisted.html")
    assert class_.is_open is True
    assert class_.is_full is True
    assert class_.is_overbooked is False
    assert class_.is_over is False
    assert class_.user_is_blocked is False
    assert class_.user_is_enrolled is True
    assert class_.user_is_waitlisted is True
    assert class_.time_to_start is None  # timer to start disappears when user is enrolled
    assert class_.time_to_enroll is None
    assert class_.enroll_url is None
    assert bool(class_.unenroll_url)


def test_not_yet_open() -> None:
    class_: Class = extract_class("not_yet_open.html")
    assert class_.is_open is False
    assert class_.is_full is False
    assert class_.is_overbooked is False
    assert class_.is_over is False
    assert class_.user_is_blocked is True
    assert class_.user_is_enrolled is False
    assert class_.user_is_waitlisted is False
    assert class_.time_to_start is None
    assert class_.time_to_enroll is not None
    assert class_.time_to_enroll > 0
    assert class_.enroll_url is None
    assert class_.unenroll_url is None
