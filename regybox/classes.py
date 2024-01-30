import datetime
import re
from dataclasses import dataclass, field
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from bs4.element import NavigableString, Tag

from regybox.common import LOGGER, TIMEZONE
from regybox.connection import DOMAIN, get_classes_html, get_url_html
from regybox.exceptions import ClassNotFoundError


@dataclass
class Class:
    """Represents a class.

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
        is_full: Indicates if the class is full.
        is_enrolled: Indicates if the user is enrolled in the class.
        is_over: Indicates if the class is over.
        is_blocked: Indicates if the user is blocked from enrolling in the
            class.
        is_waitlisted: Indicates if the user is on the class waitlist.
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
    is_open: bool
    is_full: bool
    is_enrolled: bool
    is_over: bool = False
    is_blocked: bool = False
    is_waitlisted: bool = False
    time_to_start: int | None = None
    time_to_enroll: int | None = None
    enroll_url: str | None = field(init=True, repr=False, default=None)
    unenroll_url: str | None = field(init=True, repr=False, default=None)

    def __init__(self, tag: Tag) -> None:
        """Initializes a Class object.

        Args:
            tag: The HTML tag representing the class.

        Raises:
            ValueError: If unable to parse the class HTML.
        """
        self._tag = tag
        name: Tag | NavigableString | None = self._tag.find(
            "div", attrs={"align": "left", "class": "col-50"}
        )
        location: Tag | NavigableString | None = self._tag.find(
            "div", attrs={"align": "right", "class": "col-50"}
        )
        date: int = int(self._tag.attrs["id"].removeprefix("feed_time_slot"))
        time_: Tag | NavigableString | None = self._tag.find(
            "div", attrs={"align": "left", "class": "col"}
        )
        capacity: Tag | NavigableString | None = self._tag.find(
            "div", attrs={"align": "center", "class": "col"}
        )
        if name is None or location is None or time_ is None or capacity is None:
            raise ValueError("Unable to parse class HTML")

        self.name = name.text.strip()
        self.location = location.text.strip()
        self.date = datetime.datetime.fromtimestamp(date, tz=TIMEZONE).date().isoformat()
        self.start, *_, self.end = time_.text.split()
        cap_parts: list[str] = capacity.text.split()
        self.cur_capacity, self.max_capacity = int(cap_parts[0]), int(cap_parts[-1])
        self.is_full = self.cur_capacity >= self.max_capacity

        self._init_button()
        self._init_state()
        self._init_timer()

    def _init_button(self) -> None:
        button: Tag | NavigableString | None = self._tag.find("button")
        self.is_open = bool(button)

        if isinstance(button, NavigableString):
            raise ValueError(f"Unexpected button format: {button}")
        if button is None:
            self.is_enrolled = False
        elif "color-red" in button.attrs["class"]:
            self.is_enrolled = True
            self.unenroll_url = self._get_button_url(button)
        elif all(attr in button.attrs["class"] for attr in ["buts_inscrever", "color-green"]):
            self.is_enrolled = False
            self.enroll_url = self._get_button_url(button)
        else:
            raise ValueError(f"Unexpected properties in button object: {button.attrs['class']}")

    def _init_state(self) -> None:
        states: list[Tag | NavigableString] = self._tag.find_all(
            "div", attrs={"align": "right", "class": "col"}
        )
        if not states:
            raise ValueError("Unable to parse class HTML")
        state: Tag | NavigableString | None = states[-1]
        if not isinstance(state, Tag):
            raise ValueError(f"Unexpected type for state: {state}")

        if state.find("span", attrs={"class": "erro_color"}):
            self.is_blocked = True  # enroll window expired
        elif state := state.find("div", attrs={"style": "padding-top:7px;"}):
            if not isinstance(state, Tag):
                raise ValueError(f"Unexpected type for state: {state}")
            if "class" not in state.attrs:
                self.is_over = True
            elif "letra_10" in state.attrs["class"]:
                self.is_blocked = True  # already enrolled in a class today
        # if state has no child div, there is a timer

    def _init_timer(self) -> None:
        timer: Tag | NavigableString | None = self._tag.find("input", attrs={"class": "timers"})
        if isinstance(timer, Tag):
            if not self.is_enrolled:  # timer disappears once you're enrolled
                self.time_to_start = int(timer.attrs["value"])
            if not self.is_open:
                self.time_to_enroll = int(timer.attrs["value"])

    @staticmethod
    def _get_button_url(button: Tag) -> str:
        onclick: str = button.attrs["onclick"]
        LOGGER.debug(f"Found button onclick action: '{onclick}")
        button_urls: list[str] = [
            part for part in onclick.split("'") if part.startswith("php/aulas/")
        ]
        if len(button_urls) != 1:
            raise RuntimeError(f"Expecting one url in button, found {len(button_urls)}: {onclick}")
        return urljoin(DOMAIN, button_urls[0])

    def enroll(self) -> str:
        if self.enroll_url is None:
            raise ValueError("Enroll URL is not set")
        if self.is_enrolled:
            raise RuntimeError("Already enrolled in class")
        if not self.is_open:
            raise RuntimeError("Class is not available")
        if self.is_full:
            raise RuntimeError("Class is full")

        res_html: str = get_url_html(self.enroll_url)
        LOGGER.debug(f"Enrolled at {self.enroll_url} with response: '{res_html}'")
        self.is_enrolled = True
        # set is_waitlisted here
        soup = BeautifulSoup(res_html, "html.parser")
        responses: list[str] = re.findall(
            r"parent\.msg_toast_icon\s\(\"(.+)\",",
            soup.find_all("script")[-1].text,
        )
        if len(responses) != 1:
            raise RuntimeError(f"Couldn't parse response for enrollment: {res_html}")
        LOGGER.info(f"Enrolled with response '{responses[0]}'")
        return responses[0]

    def unenroll(self) -> str:
        if self.unenroll_url is None:
            raise ValueError("Unenroll URL is not set")
        if not self.is_enrolled:
            raise RuntimeError("Not enrolled in class")

        res_html: str = get_url_html(self.unenroll_url)
        LOGGER.info(f"Unenrolled at {self.unenroll_url} with response: '{res_html}'")
        self.is_enrolled = False
        soup = BeautifulSoup(res_html, "html.parser")
        responses: list[str] = re.findall(
            r"parent\.msg_toast_icon\s\(\"(.+)\",",
            soup.find_all("script")[-1].text,
        )
        if len(responses) != 1:
            raise RuntimeError(f"Couldn't parse response for unenrollment: {res_html}")
        LOGGER.info(responses[0])
        return responses[0]


def get_classes(year: int, month: int, day: int) -> list[Class]:
    timestamp: int = int(datetime.datetime(year, month, day, tzinfo=TIMEZONE).timestamp() * 1000)
    res_html = get_classes_html(timestamp)
    soup: BeautifulSoup = BeautifulSoup(res_html, "html.parser")
    return [Class(tag) for tag in soup.find_all("div", attrs={"class": "filtro0"})]


def pick_class(
    classes: list[Class], *, class_time: str, class_type: str, class_date: str
) -> Class:
    for class_ in classes:
        if (
            class_.start != class_time
            or class_.name.upper() != class_type.upper()
            or class_.date != class_date
        ):
            continue
        return class_
    raise ClassNotFoundError(
        f"Unable to find class '{class_type}' at {class_time} on {class_date}."
    )