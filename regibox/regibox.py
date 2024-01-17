import datetime
import logging
import os
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin

import pytz
import requests
from bs4 import BeautifulSoup
from bs4.element import NavigableString, Tag
from dotenv import find_dotenv, load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

load_dotenv(dotenv_path=find_dotenv(usecwd=True))

logging.basicConfig(
    format="%(asctime)s %(levelname)s [%(name)s] [%(filename)s:%(lineno)d] - %(message)s",
    level=logging.INFO,
)
LOGGER: logging.Logger = logging.getLogger("REGIBOX")

TIMEZONE: pytz.BaseTzInfo = pytz.timezone("Europe/Lisbon")
START: datetime.datetime = datetime.datetime.now(TIMEZONE)

USER: str = os.environ["REGIBOX_USER"]
DOMAIN: str = "https://www.regibox.pt/app/app_nova/"
HEADERS: dict[str, str] = {
    "Accept": "text/html, */*; q=0.01",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": f'PHPSESSID={os.environ["PHPSESSID"]}; regybox_boxes=%2A{USER}; regybox_user={USER}',
    "DNT": "1",
    "Host": "www.regibox.pt",
    "Referer": DOMAIN,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"
        " Chrome/120.0.0.0 Safari/537.36"
    ),
    "X-Requested-With": "XMLHttpRequest",
    "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
}

SESSION: requests.Session = requests.Session()
ADAPTER: HTTPAdapter = HTTPAdapter(max_retries=Retry(connect=10, backoff_factor=0.5))
SESSION.mount("http://", ADAPTER)
SESSION.mount("https://", ADAPTER)


@dataclass
class WaitTime:
    inf_sec: int = 5
    sup_sec: int = 50
    slow: int = 9
    fast: int = 1

    @classmethod
    def get(cls, now_seconds: int) -> int:
        return cls.slow if cls.inf_sec < now_seconds < cls.sup_sec else cls.fast


@dataclass
class Class:
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
    time_to_start: str | None = None
    time_to_enroll: str | None = None
    enroll_url: str | None = field(init=True, repr=False, default=None)
    unenroll_url: str | None = field(init=True, repr=False, default=None)

    def __init__(self, tag: Tag) -> None:
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
                self.time_to_start = str(datetime.timedelta(seconds=int(timer.attrs["value"])))
            if not self.is_open:
                self.time_to_enroll = str(datetime.timedelta(seconds=int(timer.attrs["value"])))

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

        res: requests.models.Response = SESSION.get(self.enroll_url, headers=HEADERS, timeout=10)
        res.raise_for_status()
        LOGGER.info(f"Enrolled at {self.enroll_url} with response: '{res.text}'")
        self.is_enrolled = True
        # set is_waitlisted here
        soup = BeautifulSoup(res.text, "html.parser")
        responses: list[str] = re.findall(
            r"parent\.msg_toast_icon\s\(\"(.+)\",",
            soup.find_all("script")[-1].text,
        )
        if len(responses) != 1:
            raise RuntimeError(f"Couldn't parse response for enrollment: {res.text}")
        LOGGER.info(responses[0])
        return responses[0]

    def unenroll(self) -> str:
        if self.unenroll_url is None:
            raise ValueError("Unenroll URL is not set")
        if not self.is_enrolled:
            raise RuntimeError("Not enrolled in class")

        res: requests.models.Response = SESSION.get(self.unenroll_url, headers=HEADERS, timeout=10)
        res.raise_for_status()
        LOGGER.info(f"Unenrolled at {self.unenroll_url} with response: '{res.text}'")
        self.is_enrolled = False
        soup = BeautifulSoup(res.text, "html.parser")
        responses: list[str] = re.findall(
            r"parent\.msg_toast_icon\s\(\"(.+)\",",
            soup.find_all("script")[-1].text,
        )
        if len(responses) != 1:
            raise RuntimeError(f"Couldn't parse response for unenrollment: {res.text}")
        LOGGER.info(responses[0])
        return responses[0]


def get_enroll_params(timestamp: int, user: str = USER) -> dict[str, str]:
    return {
        "valor1": str(timestamp),
        "type": "",
        "source": "mes",
        "scroll": "s",
        "z": user,
    }


def get_session_params(user: str = USER) -> dict[str, str]:
    return {
        "z": user,
        "y": f"*{user}",
        "ignore": "regibox.pt/app/app",
    }


def set_session(session: requests.Session, user: str = USER) -> requests.Session:
    session.get(
        urljoin(DOMAIN, "set_session.php"),
        headers=HEADERS,
        params=get_session_params(user),
    ).raise_for_status()
    return session


def get_classes(
    year: int, month: int, day: int, *, session: requests.Session, user: str = USER
) -> list[Class]:
    timestamp: int = int(datetime.datetime(year, month, day, tzinfo=TIMEZONE).timestamp() * 1000)
    res: requests.models.Response = session.get(
        urljoin(DOMAIN, "php/aulas/aulas.php"),
        params=get_enroll_params(timestamp, user=user),
        headers=HEADERS,
        timeout=10,
    )
    res.raise_for_status()
    soup: BeautifulSoup = BeautifulSoup(res.text, "html.parser")
    return [Class(tag) for tag in soup.find_all("div", attrs={"class": "filtro0"})]


def pick_class(classes: list[Class], class_time: str, class_type: str) -> Class:
    for class_ in classes:
        if class_.start != class_time or class_.name != class_type:
            continue
        return class_
    raise RuntimeError(f"Unable to find enroll button for class '{class_type}' at {class_time}.")


def main(
    class_date: str | None = None, class_time: str = "12:00", class_type: str = "WOD RATO"
) -> None:
    class_time = class_time.zfill(5)  # needs leading zeros
    LOGGER.info(f"Started at {START.isoformat()}")
    if not class_date:
        date: datetime.datetime = datetime.datetime.now(TIMEZONE) + datetime.timedelta(days=2)
    else:
        date = datetime.datetime.strptime(class_date, "%Y-%m-%d").replace(tzinfo=TIMEZONE)
    timeout: int = 900  # try for 15 minutes

    session = set_session(SESSION)
    while (datetime.datetime.now(TIMEZONE) - START).total_seconds() < timeout:
        classes: list[Class] = get_classes(date.year, date.month, date.day, session=session)
        try:
            class_: Class = pick_class(classes, class_time, class_type)
        except RuntimeError:
            # seconds between calls
            wait: int = WaitTime.get(datetime.datetime.now(TIMEZONE).second)
            LOGGER.info(
                f"No button found for {class_type} on {date.date().isoformat()} at"
                f" {class_time}, retrying in {wait} seconds."
            )
            time.sleep(wait)
        else:
            break
    else:
        raise RuntimeError(
            f"Timed out waiting for class {class_type} on {date.date().isoformat()} at"
            f" {class_time}, terminating."
        )
    class_.enroll()
    LOGGER.info(f"Runtime: {(datetime.datetime.now(TIMEZONE) - START).total_seconds():.3f}")
