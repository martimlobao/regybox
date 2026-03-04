from importlib import resources
from unittest.mock import patch

import pytest
from bs4 import BeautifulSoup
from bs4.element import PageElement, Tag

from regybox.classes import (
    Class,
    get_classes,
    get_classes_tags,
    parse_capacity_value,
    pick_class,
)
from regybox.exceptions import (
    ClassNotFoundError,
    NoClassesFoundError,
    UnparseableError,
)

from . import html_examples

INFINITE_CLASS_CURRENT_CAPACITY = 3


def extract_class(filename: str) -> Class:
    html: str = resources.files(html_examples).joinpath(filename).read_text()
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
    class_: Class = extract_class("full.html")
    assert class_.is_open is True
    assert class_.is_full is True
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


def test_overbooked() -> None:
    class_: Class = extract_class("overbooked.html")
    assert class_.is_open is False
    assert class_.is_full is True
    assert class_.is_overbooked is True
    assert class_.is_over is False
    assert class_.user_is_blocked is True
    assert class_.user_is_enrolled is False
    assert class_.user_is_waitlisted is False
    assert class_.time_to_start is None  # timer to start disappears when class is overbooked
    assert class_.time_to_enroll is None
    assert class_.enroll_url is None
    assert class_.unenroll_url is None


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


def test_unlimited() -> None:
    class_: Class = extract_class("unlimited.html")
    assert class_.is_open is False
    assert class_.is_full is False
    assert class_.max_capacity is None
    assert class_.cur_capacity == 0
    assert class_.is_overbooked is False
    assert class_.is_over is False
    assert class_.user_is_waitlisted is False
    assert class_.time_to_start is None
    assert class_.time_to_enroll is not None
    assert class_.time_to_enroll > 0
    assert class_.enroll_url is None
    assert class_.unenroll_url is None


def test_parse_capacity_empty_string_raises() -> None:
    with pytest.raises(UnparseableError):
        parse_capacity_value("")


def test_parse_capacity_non_numeric_raises() -> None:
    with pytest.raises(UnparseableError):
        parse_capacity_value("abc")


def test_parse_capacity_malformed_raises() -> None:
    with pytest.raises(UnparseableError):
        parse_capacity_value("12/34/56")


def test_parse_capacity_infinity_returns_none() -> None:
    assert parse_capacity_value("∞") is None


def test_enroll_returns_message() -> None:
    """Enroll() returns the message from the response script."""
    class_: Class = extract_class("open.html")
    enroll_html = (
        "<html><body><script>"
        'parent.msg_toast_icon("Inscrito com sucesso", "ok");'
        "</script></body></html>"
    )
    with patch("regybox.classes.get_url_html", return_value=enroll_html):
        result = class_.enroll()
    assert result == "Inscrito com sucesso"


def test_enroll_sets_waitlisted_when_lista_espera_in_response() -> None:
    """Enroll() sets user_is_waitlisted when response contains lista_espera."""
    class_: Class = extract_class("open.html")
    enroll_html = (
        "<html><body><script>"
        "parent.popup('php/popups/lista_espera.php');"
        'parent.msg_toast_icon("Waitlisted", "ok");'
        "</script></body></html>"
    )
    with patch("regybox.classes.get_url_html", return_value=enroll_html):
        class_.enroll()
    assert class_.user_is_waitlisted is True


def test_enroll_raises_unparseable_when_no_response_script() -> None:
    """Enroll() raises UnparseableError when no msg_toast_icon in response."""
    class_: Class = extract_class("open.html")
    with (
        patch("regybox.classes.get_url_html", return_value="<html><body>no script</body></html>"),
        pytest.raises(UnparseableError),
    ):
        class_.enroll()


def test_unenroll_returns_message() -> None:
    """Unenroll() returns the message from the response script."""
    class_: Class = extract_class("registered.html")
    unenroll_html = (
        '<html><body><script>parent.msg_toast_icon("Cancelado", "ok");</script></body></html>'
    )
    with patch("regybox.classes.get_url_html", return_value=unenroll_html):
        result = class_.unenroll()
    assert result == "Cancelado"


def test_unenroll_raises_unparseable_when_no_response_script() -> None:
    """Unenroll() raises UnparseableError when no msg_toast_icon."""
    class_: Class = extract_class("registered.html")
    with (
        patch("regybox.classes.get_url_html", return_value="<html><body>no script</body></html>"),
        pytest.raises(UnparseableError),
    ):
        class_.unenroll()


def test_pick_class_raises_when_not_found() -> None:
    """pick_class raises ClassNotFoundError when no matching class."""
    class_: Class = extract_class("open.html")
    with pytest.raises(ClassNotFoundError):
        pick_class(
            [class_],
            class_time="07:00",
            class_type="WOD Rato",
            class_date=class_.date,
        )


def test_get_classes_tags_raises_when_no_classes() -> None:
    """get_classes_tags raises NoClassesFoundError when HTML has no filtro0."""
    with (
        patch("regybox.classes.get_classes_html", return_value="<html><body></body></html>"),
        pytest.raises(NoClassesFoundError),
    ):
        get_classes_tags(2024, 7, 1)


def test_get_classes_returns_list_of_classes() -> None:
    """get_classes returns Class instances from get_classes_tags."""
    open_html = resources.files(html_examples).joinpath("open.html").read_text()
    with patch("regybox.classes.get_classes_html", return_value=open_html):
        classes = get_classes(2024, 7, 1)
    assert len(classes) == 1
    assert classes[0].name == "WOD Rato"
