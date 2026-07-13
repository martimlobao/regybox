"""Provide classes and functions for interacting with CrossFit classes."""

import datetime
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

import ftfy
from bs4 import BeautifulSoup
from bs4.element import NavigableString, Tag

from regybox.common import LOGGER, TIMEZONE
from regybox.connection import (
    DOMAIN,
    get_classes_html,
    get_url_html,
)
from regybox.exceptions import (
    ClassIsOverbookedError,
    ClassNotFoundError,
    ClassNotOpenError,
    NoClassesFoundError,
    UnparseableError,
    UserAlreadyEnrolledError,
)

EMPTY_CLASS_RETRY_TOTAL: int = 10
EMPTY_CLASS_RETRY_BACKOFF_FACTOR: float = 0.05


def parse_capacity_value(value: str) -> int | None:
    """Convert the capacity token to an integer when possible.

    The booking platform can display an infinity symbol when there is no
    explicit limit for a class. In that case we represent the capacity as
    ``None`` so the rest of the application can continue to operate.

    Returns:
        The parsed integer capacity or ``None`` when unlimited.

    Raises:
        UnparseableError: If the capacity value uses an unknown format.
    """
    normalized: str = value.strip()
    if normalized == "∞":
        return None
    try:
        return int(normalized)
    except ValueError as e:
        raise UnparseableError(f"Unexpected capacity value: {value}") from e


@dataclass
class Class:
    """Represent a CrossFit class with its attributes and behavior.

    This class encapsulates the attributes and behavior of a class,
    including its name, details, date, start and end times, capacity,
    enrollment status, and various flags indicating the class state.

    Attributes:
        name: The name of the class.
        details: The details of the class.
        date: The date of the class in ISO format.
        start: The start time of the class in HH:MM format.
        end: The end time of the class in HH:MM format.
        max_capacity: The maximum capacity of the class. ``None`` represents
            unlimited capacity.
        cur_capacity: The current capacity of the class.
        is_open: Indicates if the class is open for enrollment.
        is_full: Indicates if the class has no remaining capacity, though it
            but may still be accepting users on the waitlist.
        is_overbooked: Indicates if the class and its waitlist cannot accept
            any more users.
        enrollment_deadline_expired: Indicates if enrollment is closed because
            the class is starting soon.
        is_over: Indicates if the class is over.
        user_is_blocked: Indicates if the user is blocked from enrolling in the
            class.
        user_is_enrolled: Indicates if the user is enrolled in the class.
        user_is_waitlisted: Indicates if the user is on the class waitlist.
        time_to_start: The number of seconds remaining until the class starts.
        time_to_enroll: The number of seconds until enrollment closes.
        enroll_url: The URL to enroll in the class.
        unenroll_url: The URL to unenroll from the class.
    """

    _tag: Tag = field(init=False, repr=False)
    name: str
    details: str
    date: str
    start: str
    end: str
    max_capacity: int | None
    cur_capacity: int
    is_open: bool = False
    is_full: bool = False
    is_overbooked: bool = False
    enrollment_deadline_expired: bool = False
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
        details: Tag | NavigableString | None = self._tag.find(
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
        if name is None or details is None or time_ is None or capacity is None:
            raise UnparseableError

        self.name = name.text.strip()
        self.details = ftfy.fix_text(details.text.strip())
        self.date = datetime.datetime.fromtimestamp(date, tz=TIMEZONE).date().isoformat()
        self.start, *_, self.end = time_.text.split()
        cap_parts: list[str] = capacity.text.split()
        cur_capacity: int | None = parse_capacity_value(cap_parts[0])
        if cur_capacity is None:
            raise UnparseableError(f"Unexpected capacity value: {cap_parts[0]}")
        self.cur_capacity = cur_capacity
        self.max_capacity = parse_capacity_value(cap_parts[-1])
        if self.max_capacity is not None:
            self.is_full = self.cur_capacity >= self.max_capacity
        else:
            self.is_full = False
        error: Tag | NavigableString | None = self._tag.find("span", attrs={"class": "erro_color"})
        # Avoid localized status text: Regybox uses the same error span for
        # full/closed classes and deadline-expired classes. With the current
        # markup, capacity is the stable structural signal separating them.
        self.is_overbooked = self.is_full and bool(error)
        self.enrollment_deadline_expired = bool(error) and not self.is_full
        self.user_is_waitlisted = bool(
            self._tag.find("div", attrs={"class": re.compile(r"preloader\s*color-orange")})
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

        Raises:
            UnparseableError: If class action buttons are ambiguous or use an
                unknown booking endpoint.
        """
        button_actions, unknown_action_endpoints = self._get_button_actions()
        if unknown_action_endpoints:
            raise UnparseableError(
                f"Unknown class action endpoint: {', '.join(unknown_action_endpoints)}"
            )
        if len(button_actions) > 1:
            endpoints = [urlparse(url).path for _, url in button_actions]
            raise UnparseableError(f"Ambiguous class action controls: {', '.join(endpoints)}")
        button_action = button_actions[0] if button_actions else None
        self.is_open = bool(button_action)
        if self._tag.find(
            "div", attrs={"class": "letra_10", "style": re.compile(r"padding-top:\s*7px")}
        ):
            # edge case when class is open but user is already enrolled in
            # another class
            self.is_open = True

        if (
            self._tag.find(
                "div",
                attrs={
                    "align": "right",
                    "class": "ok_color",
                    "style": re.compile(r"padding-top:\s*1px"),
                },
            )
            is not None
        ):
            self.user_is_enrolled = True
        elif button_action is None:
            self.user_is_enrolled = False
        elif button_action[0] == "unenroll":
            self.user_is_enrolled = True
            self.unenroll_url = button_action[1]
        elif button_action[0] == "enroll":
            self.user_is_enrolled = False
            self.enroll_url = button_action[1]

    def _get_button_actions(self) -> tuple[list[tuple[str, str]], list[str]]:
        """Return known booking actions and unknown booking-like endpoints.

        Raises:
            UnparseableError: If a known action uses an unexpected origin or
                path.
        """
        buttons: list[Tag] = self._tag.find_all("button")
        button_actions: list[tuple[str, str]] = []
        unknown_action_endpoints: list[str] = []
        domain = urlparse(DOMAIN)
        action_path_prefix = "/app/app_nova/php/aulas/"
        for button in buttons:
            button_classes = set(button.get("class", []))
            looks_like_booking_control = "buts_inscrever" in button_classes
            for button_url in self._get_button_urls(button):
                parsed_url = urlparse(button_url)
                pathname = parsed_url.path
                known_action = pathname.endswith(("/marca_aulas.php", "/cancela_aula.php"))
                if known_action and (
                    parsed_url.scheme != domain.scheme
                    or parsed_url.netloc != domain.netloc
                    or not pathname.startswith(action_path_prefix)
                ):
                    raise UnparseableError(
                        "Class action control used an unexpected origin or path"
                    )
                if pathname == f"{action_path_prefix}marca_aulas.php":
                    button_actions.append(("enroll", button_url))
                elif pathname == f"{action_path_prefix}cancela_aula.php":
                    button_actions.append(("unenroll", button_url))
                elif looks_like_booking_control and re.search(
                    r"/aulas/[^/]+\.php$", pathname, re.IGNORECASE
                ):
                    unknown_action_endpoints.append(pathname)
        return button_actions, unknown_action_endpoints

    def _init_state(self) -> None:
        """Sets class attributes mainly using class descriptors.

        This method sets the following attributes:
            * is_over
            * user_is_blocked

        Raises:
            ValueError: If the state object is not found.
            TypeError: If the state object is not of the expected type.
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
        elif state := state.find("div", attrs={"style": re.compile(r"padding-top:\s*7px")}):
            if not isinstance(state, Tag):
                raise TypeError(f"Unexpected type for state: {state}")
            if self.user_is_waitlisted:
                # next check fails for waitlisted classes
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
    def _get_button_urls(button: Tag) -> list[str]:
        onclick = str(button.attrs.get("onclick", ""))
        raw_urls = re.findall(r"[^'\"\s,(]+\.php(?:\?[^'\"\s,)]*)?", onclick, re.IGNORECASE)
        urls = [urljoin(DOMAIN, raw_url) for raw_url in raw_urls]
        LOGGER.debug("Found %d PHP button endpoint(s)", len(urls))
        return urls

    def enroll(self) -> str:
        """Enroll the student in the CrossFit class.

        Returns:
            The response message after successful enrollment.

        Raises:
            ValueError: If the enroll URL is not set.
            UserAlreadyEnrolledError: If the user is already enrolled in the
                class.
            ClassNotOpenError: If the class is not open for enrollment.
            ClassIsOverbookedError: If the class is already overbooked.
            UnparseableError: If the response for enrollment cannot be parsed.
        """
        if self.user_is_enrolled:
            raise UserAlreadyEnrolledError
        if self.is_overbooked:
            raise ClassIsOverbookedError
        if self.enroll_url is None:
            raise ValueError("Enroll URL is not set")
        if not self.is_open:
            raise ClassNotOpenError

        res_html: str = get_url_html(self.enroll_url)
        LOGGER.debug(f"Enrolled at {self.enroll_url} with response: '{res_html}'")
        self.user_is_enrolled = True
        soup = BeautifulSoup(res_html, "html.parser")
        scripts: list[Tag] = soup.find_all("script")
        self.user_is_waitlisted = False
        waitlist_script = _find_script_containing(scripts, "lista_espera.php")
        if waitlist_script is not None:
            self.user_is_waitlisted = bool(
                re.findall(
                    r"parent.popup\('php\/popups\/lista_espera\.php'",
                    waitlist_script,
                )
            )
        response_script = _find_script_containing(scripts, "msg_toast_icon")
        if response_script is None:
            raise UnparseableError(f"Couldn't parse response for enrollment: {res_html}")
        responses: list[str] = re.findall(
            r"parent\.msg_toast_icon\s*\(\"(.+?)\",",
            response_script,
        )
        if len(responses) != 1:
            raise UnparseableError(f"Couldn't parse response for enrollment: {res_html}")
        response = ftfy.fix_text(responses[0])
        LOGGER.info(f"Enrolled with response '{response}'")
        return response

    def unenroll(self) -> str:
        """Unenroll the student from the CrossFit class.

        Returns:
            The response message indicating successful unenrollment.

        Raises:
            ValueError: If the unenroll URL is not set.
            RuntimeError: If the student is not enrolled in the class.
            UnparseableError: If the unenrollment response cannot be parsed.
        """
        if self.unenroll_url is None:
            raise ValueError("Unenroll URL is not set")
        if not self.user_is_enrolled:
            raise RuntimeError("Not enrolled in class")

        res_html: str = get_url_html(self.unenroll_url)
        LOGGER.debug(f"Unenrolled at {self.unenroll_url} with response: '{res_html}'")
        self.user_is_enrolled = False
        soup = BeautifulSoup(res_html, "html.parser")
        response_script = _find_script_containing(soup.find_all("script"), "msg_toast_icon")
        if response_script is None:
            raise UnparseableError(f"Couldn't parse response for unenrollment: {res_html}")
        responses: list[str] = re.findall(
            r"parent\.msg_toast_icon\s*\(\"(.+?)\",",
            response_script,
        )
        if len(responses) != 1:
            raise UnparseableError(f"Couldn't parse response for unenrollment: {res_html}")
        response = ftfy.fix_text(responses[0])
        LOGGER.info(f"Unenrolled with response '{response}'")
        return response


def _find_script_containing(scripts: list[Tag], needle: str) -> str | None:
    """Return the text of the first script tag containing a substring."""
    for script in scripts:
        text = script.text
        if text and needle in text:
            return text
    return None


def _get_classes_tags_with_retry(
    timestamp: int,
    *,
    retry_total: int = EMPTY_CLASS_RETRY_TOTAL,
    retry_backoff_factor: float = EMPTY_CLASS_RETRY_BACKOFF_FACTOR,
) -> list[Tag]:
    """Fetch class tags, retrying when no classes are found.

    Args:
        timestamp: The class date timestamp in milliseconds.
        retry_total: The number of empty responses to retry after the initial
            request.
        retry_backoff_factor: The base delay for exponential retry backoff.

    Returns:
        The parsed class tags, or an empty list for a valid response with no
        classes.
    """
    max_fetch_attempts = retry_total + 1
    for attempt in range(max_fetch_attempts):
        res_html = get_classes_html(timestamp)
        soup: BeautifulSoup = BeautifulSoup(res_html, "html.parser")
        classes: list[Tag] = soup.find_all("div", attrs={"class": "filtro0"})
        if classes:
            return classes
        if attempt < retry_total:
            wait = retry_backoff_factor * (2**attempt)
            LOGGER.warning(f"No classes found in response; retrying in {wait:.2f} seconds.")
            time.sleep(wait)
    return []


def get_classes_tags(year: int, month: int, day: int) -> list[Tag]:
    """Fetch all class tags for a specific date.

    Args:
        year: The year of the date.
        month: The month of the date.
        day: The day of the date.

    Returns:
        A list of Tag objects containing the HTML for the classes for
        the specified date.

    Raises:
        NoClassesFoundError: If no classes are found for the specified date.
    """
    timestamp: int = int(datetime.datetime(year, month, day, tzinfo=TIMEZONE).timestamp() * 1000)
    classes = _get_classes_tags_with_retry(timestamp)
    if not classes:
        raise NoClassesFoundError(class_date=f"{year}-{month}-{day}")
    return classes


def get_classes(year: int, month: int, day: int) -> list[Class]:
    """Fetch all classes for a specific date.

    Args:
        year: The year of the date.
        month: The month of the date.
        day: The day of the date.

    Returns:
        A list of Class objects for the specified date.
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
