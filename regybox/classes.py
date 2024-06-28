"""Provide classes and functions for interacting with CrossFit classes."""

import datetime
import re
from dataclasses import dataclass, field
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from bs4.element import NavigableString, Tag

from regybox.common import LOGGER, TIMEZONE
from regybox.connection import DOMAIN, get_classes_html, get_url_html
from regybox.exceptions import (
    ClassIsOverbookedError,
    ClassNotFoundError,
    ClassNotOpenError,
    UnparseableError,
    UserAlreadyEnrolledError,
)


@dataclass
class Class:
    """Represent a CrossFit class with its attributes and behavior.

    This class encapsulates the attributes and behavior of a class,
    including its name, location, date, start and end times, capacity,
    enrollment status, and various flags indicating the class state.

    Attributes:
        name: The name of the class.
        location: The location of the class.
        date: The date of the class in ISO format.
        start: The start time of the class in HH:MM format.
        end: The end time of the class in HH:MM format.
        max_capacity: The maximum capacity of the class.
        cur_capacity: The current capacity of the class.
        is_open: Indicates if the class is open for enrollment.
        is_full: Indicates if the class has no remaining capacity, though it
            but may still be accepting users on the waitlist.
        is_overbooked: Indicates if the class and its waitlist cannot accept
            any more users.
        is_over: Indicates if the class is over.
        user_is_blocked: Indicates if the user is blocked from enrolling in the
            class.
        user_is_enrolled: Indicates if the user is enrolled in the class.
        user_is_waitlisted: Indicates if the user is on the class waitlist.
        time_to_start: The number of seconds remaining until the class starts.
        time_to_enroll: The number of seconds remaining until enrollment closes.
        enroll_url: The URL to enroll in the class.
        unenroll_url: The URL to unenroll from the class.
    """

    _tag: Tag = field(init=False, repr=False)
    name: str
    location: str
    date: str
    start: str
    end: str
    max_capacity: int
    cur_capacity: int
    is_open: bool = False
    is_full: bool = False
    is_overbooked: bool = False
    is_over: bool = False
    user_is_blocked: bool = False
    user_is_enrolled: bool = False
    user_is_waitlisted: bool = False
    time_to_start: int | None = None
    time_to_enroll: int | None = None
    enroll_url: str | None = field(init=True, repr=False, default=None)
    unenroll_url: str | None = field(init=True, repr=False, default=None)

    def __init__(self, tag: Tag) -> None:
        """Initialize a Class object.

        Args:
            tag: The HTML tag representing the class.

        Raises:
            UnparseableError: If unable to parse the class HTML.
        """
        self._tag = tag
        name: Tag | NavigableString | None = self._tag.find(
            "div", attrs={"align": "left", "class": "col-50"}
        )
        location: Tag | NavigableString | None = self._tag.find(
            "div", attrs={"align": "right", "class": "col-50"}
        )
        try:
            date: int = int(self._tag.attrs["id"].removeprefix("feed_time_slot"))
        except KeyError as e:
            raise UnparseableError from e
        time_: Tag | NavigableString | None = self._tag.find(
            "div", attrs={"align": "left", "class": "col"}
        )
        capacity: Tag | NavigableString | None = self._tag.find(
            "div", attrs={"align": "center", "class": "col"}
        )
        if name is None or location is None or time_ is None or capacity is None:
            raise UnparseableError

        self.name = name.text.strip()
        self.location = location.text.strip()
        self.date = datetime.datetime.fromtimestamp(date, tz=TIMEZONE).date().isoformat()
        self.start, *_, self.end = time_.text.split()
        cap_parts: list[str] = capacity.text.split()
        self.cur_capacity, self.max_capacity = int(cap_parts[0]), int(cap_parts[-1])
        self.is_full = self.cur_capacity >= self.max_capacity
        self.is_overbooked = bool(self._tag.find("span", attrs={"class": "erro_color"}))
        self.user_is_waitlisted = bool(
            self._tag.find("div", attrs={"class": "preloader color-orange"})
        )

        self._init_button()
        self._init_state()
        self._init_timer()

    def _init_button(self) -> None:
        """Sets class attributes mainly using button state.

        This method sets the following attributes:
            * is_open
            * user_is_enrolled
            * unenroll_url
            * enroll_url
        """
        button: Tag | NavigableString | None = self._tag.find("button")
        self.is_open = bool(button)
        if self._tag.find("div", attrs={"class": "letra_10", "style": "padding-top:7px;"}):
            # edge case when class is open but user is already enrolled in
            # another class
            self.is_open = True

        if isinstance(button, NavigableString):
            raise TypeError(f"Unexpected button format: {button}")
        if (
            self._tag.find(
                "div", attrs={"align": "right", "class": "ok_color", "style": "padding-top:1px;"}
            )
            is not None
        ):
            self.user_is_enrolled = True
        elif button is None:
            self.user_is_enrolled = False
        elif "color-red" in button.attrs["class"]:
            self.user_is_enrolled = True
            self.unenroll_url = self._get_button_url(button)
        elif all(attr in button.attrs["class"] for attr in ["buts_inscrever", "color-green"]):
            self.user_is_enrolled = False
            self.enroll_url = self._get_button_url(button)
        else:
            raise ValueError(f"Unexpected properties in button object: {button.attrs['class']}")

    def _init_state(self) -> None:
        """Sets class attributes mainly using class descriptors.

        This method sets the following attributes:
            * is_over
            * user_is_blocked
        """
        states: list[Tag | NavigableString] = self._tag.find_all(
            "div", attrs={"align": "right", "class": "col"}
        )
        if not states:
            raise ValueError
        state: Tag | NavigableString | None = states[-1]
        if not isinstance(state, Tag):
            raise TypeError(f"Unexpected type for state: {state}")

        if not self.is_open and not self.user_is_enrolled:
            self.user_is_blocked = True

        if state.find("span", attrs={"class": "erro_color"}):
            self.user_is_blocked = True  # enroll window expired
        elif state := state.find("div", attrs={"style": "padding-top:7px;"}):
            if not isinstance(state, Tag):
                raise ValueError(f"Unexpected type for state: {state}")
            if self.user_is_waitlisted:
                # explicit logic because next check fails for waitlisted classes
                self.is_over = False
            elif "class" not in state.attrs:
                self.is_over = True
            elif "letra_10" in state.attrs["class"]:
                self.user_is_blocked = True  # already enrolled in a class today
        # if state has no child div, there is a timer

    def _init_timer(self) -> None:
        """Sets class attributes using timers.

        This method sets the following attributes:
            * time_to_start
            * time_to_enroll
        """
        timer: Tag | NavigableString | None = self._tag.find("input", attrs={"class": "timers"})
        if isinstance(timer, Tag):
            if not self.is_open:
                self.time_to_enroll = int(timer.attrs["value"])
            elif not self.user_is_enrolled:  # timer disappears once you're enrolled
                self.time_to_start = int(timer.attrs["value"])

    @staticmethod
    def _get_button_url(button: Tag) -> str:
        onclick: str = button.attrs["onclick"]
        LOGGER.debug(f"Found button onclick action: '{onclick}")
        button_urls: list[str] = [
            part for part in onclick.split("'") if ".php" in part
        ]
        if len(button_urls) != 1:
            raise UnparseableError(
                f"Expecting one url in button, found {len(button_urls)}: {onclick}"
            )
        return urljoin(DOMAIN, button_urls[0])

    def enroll(self) -> str:
        """Enroll the student in the CrossFit class.

        Raises:
            ValueError: If the enroll URL is not set.
            UserAlreadyEnrolledError: If the user is already enrolled in the
                class.
            ClassNotOpenError: If the class is not open for enrollment.
            ClassIsOverbookedError: If the class is already overbooked.
            UnparseableError: If the response for enrollment cannot be parsed.

        Returns:
            The response message after successful enrollment.
        """
        if self.user_is_enrolled:
            raise UserAlreadyEnrolledError
        if self.enroll_url is None:
            raise ValueError("Enroll URL is not set")
        if not self.is_open:
            raise ClassNotOpenError
        if self.is_overbooked:
            raise ClassIsOverbookedError

        res_html: str = get_url_html(self.enroll_url)
        LOGGER.debug(f"Enrolled at {self.enroll_url} with response: '{res_html}'")
        self.user_is_enrolled = True
        soup = BeautifulSoup(res_html, "html.parser")
        self.user_is_waitlisted = bool(
            re.findall(
                r"parent.popup\('php\/popups\/lista_espera\.php'",
                soup.find_all("script")[0].text,
            )
        )
        responses: list[str] = re.findall(
            r"parent\.msg_toast_icon\s\(\"(.+)\",",
            soup.find_all("script")[-1].text,
        )
        if len(responses) != 1:
            raise UnparseableError(f"Couldn't parse response for enrollment: {res_html}")
        LOGGER.info(f"Enrolled with response '{responses[0]}'")
        return responses[0]

    def unenroll(self) -> str:
        """Unenroll the student from the CrossFit class.

        Raises:
            ValueError: If the unenroll URL is not set.
            RuntimeError: If the student is not enrolled in the class.
            UnparseableError: If the response for unenrollment cannot be parsed.

        Returns:
            The response message indicating successful unenrollment.
        """
        if self.unenroll_url is None:
            raise ValueError("Unenroll URL is not set")
        if not self.user_is_enrolled:
            raise RuntimeError("Not enrolled in class")

        res_html: str = get_url_html(self.unenroll_url)
        LOGGER.info(f"Unenrolled at {self.unenroll_url} with response: '{res_html}'")
        self.user_is_enrolled = False
        soup = BeautifulSoup(res_html, "html.parser")
        responses: list[str] = re.findall(
            r"parent\.msg_toast_icon\s\(\"(.+)\",",
            soup.find_all("script")[-1].text,
        )
        if len(responses) != 1:
            raise UnparseableError(f"Couldn't parse response for unenrollment: {res_html}")
        LOGGER.info(responses[0])
        return responses[0]


def get_classes_tags(year: int, month: int, day: int) -> list[Tag]:
    """Fetch all class tags for a specific date.

    Args:
        year: The year of the date.
        month: The month of the date.
        day: The day of the date.

    Returns:
        A list of Tag objects containing the HTML for the classes for
        the specified date.
    """
    timestamp: int = int(datetime.datetime(year, month, day, tzinfo=TIMEZONE).timestamp() * 1000)
    res_html = get_classes_html(timestamp)
    soup: BeautifulSoup = BeautifulSoup(res_html, "html.parser")
    return soup.find_all("div", attrs={"class": "filtro0"})


def get_classes(year: int, month: int, day: int) -> list[Class]:
    """Fetch all classes for a specific date.

    Args:
        year: The year of the date.
        month: The month of the date.
        day: The day of the date.

    Returns:
        A list of Class objects representing the classes for the specified date.
    """
    return [Class(tag) for tag in get_classes_tags(year, month, day)]


def pick_class(
    classes: list[Class], *, class_time: str, class_type: str, class_date: str
) -> Class:
    """Pick a class from the given list based on the specified criteria.

    Args:
        classes: The list of classes to search from.
        class_time: The desired class time.
        class_type: The desired class type.
        class_date: The desired class date.

    Returns:
        The selected class.

    Raises:
        ClassNotFoundError: If no class matching the specified criteria is
            found.
    """
    for class_ in classes:
        if (
            class_.start != class_time
            or class_.name.upper() != class_type.upper()
            or class_.date != class_date
        ):
            continue
        return class_
    raise ClassNotFoundError(class_type=class_type, class_time=class_time, class_date=class_date)
