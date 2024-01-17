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
# DOMAIN: str = "https://www.regibox.pt/app/app_nova/index.php"
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
    is_in_session: bool = False
    is_blocked: bool = False
    is_waitlisted: bool = False
    time_to_start: int | None = None
    time_to_enroll: int | None = None
    enroll_url: str | None = field(init=True, repr=False, default=None)
    unenroll_url: str | None = field(init=True, repr=False, default=None)


    def __init__(self, tag: Tag) -> None:
        self._tag = tag
        name: Tag | NavigableString | None = tag.find(
            "div", attrs={"align": "left", "class": "col-50"}
        )
        location: Tag | NavigableString | None = tag.find(
            "div", attrs={"align": "right", "class": "col-50"}
        )
        date: int = int(re.search(r"\d+$", tag.attrs["id"]).group())
        time_: Tag | NavigableString | None = tag.find(
            "div", attrs={"align": "left", "class": "col"}
        )
        capacity: Tag | NavigableString | None = tag.find(
            "div", attrs={"align": "center", "class": "col"}
        )
        states: list[Tag | NavigableString] = tag.find_all(
            "div", attrs={"align": "right", "class": "col"}
        )
        if None in [name, location, time_, capacity] or not states:
            raise ValueError("Unable to parse class HTML")
        state: Tag | NavigableString = states[-1]

        self.name = name.text.strip()
        self.location = location.text.strip()
        self.date = datetime.datetime.fromtimestamp(date, tz=TIMEZONE).date().isoformat()
        self.start, *_, self.end = time_.text.split()
        cap_parts: list[str] = capacity.text.split()
        self.cur_capacity, self.max_capacity = int(cap_parts[0]), int(cap_parts[-1])
        self.is_full = self.cur_capacity >= self.max_capacity

        button: Tag | NavigableString | None = tag.find("button")
        self.is_open = bool(button)

        if self.is_open:
            if "color-red" in button.attrs["class"]:
                self.is_enrolled = True
                self.unenroll_url = self._get_button_url(button)
            elif all(attr in button.attrs["class"] for attr in ["buts_inscrever", "color-green"]):
                self.is_enrolled = False
                self.enroll_url = self._get_button_url(button)
            else:
                raise ValueError(f"Unexpected properties in button object: {button['class']}")
        else:
            self.is_enrolled = False

        if state := state.find("div", attrs={"style": "padding-top:7px;"}):

            if "letra_10" in state.attrs.get("class", []):
                self.is_blocked = True  # already enrolled in a class today
            elif "ok_color" in state.attrs.get("class", []):
                assert self.is_enrolled
            elif "erro_color" in state.attrs.get("class", []):
                self.is_blocked = True  # enroll window expired
            else:
                self.is_over = True
        # if state has no child div, there is a timer

        timer: Tag | NavigableString | None = tag.find("input", attrs={"class": "timers"})
        if timer is not None:
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

    # def _get_enroll_path(self) -> str:
    #     if self.enroll_button is None:
    #         raise RuntimeError("Unable to find enroll button")

    #     onclick: str = self.enroll_button.attrs["onclick"]
    #     LOGGER.debug(f"Found button onclick action: '{onclick}")
    #     button_urls: list[str] = [
    #         part for part in onclick.split("'") if part.startswith("php/aulas/marca_aulas.php")
    #     ]
    #     if len(button_urls) != 1:
    #         raise RuntimeError(f"Expecting one page in button, found {len(button_urls)}: {onclick}")
    #     return button_urls[0]

    def enroll(self) -> str:
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


def get_classes(year: int, month: int, day: int, *, session: requests.Session, user: str = USER) -> list[Class]:
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

# def get_enroll_buttons(year: int, month: int, day: int) -> list[Tag]:
#     timestamp: int = int(datetime.datetime(year, month, day, tzinfo=TIMEZONE).timestamp() * 1000)
#     res: requests.models.Response = SESSION.get(
#         f"{DOMAIN}php/aulas/aulas.php",
#         params=get_enroll_params(timestamp),
#         headers=HEADERS,
#         timeout=10,
#     )
#     res.raise_for_status()
#     soup: BeautifulSoup = BeautifulSoup(res.text, "html.parser")
#     buttons: list[Tag] = soup.find_all("button")
#     LOGGER.debug(
#         "Found all buttons:\n\t{}".format(
#             "\n\t".join([f"{button.decode()}" for button in buttons]),
#         ),
#     )
#     buttons = [button for button in buttons if "buts_inscrever" in button["class"]]
#     LOGGER.debug(
#         "Found enrollment buttons:\n\t{}".format(
#             "\n\t".join([f"{button.decode()}" for button in buttons]),
#         ),
#     )
#     return buttons


# def pick_button(buttons: list[Tag], class_time: str, class_type: str) -> Tag:
#     class_time = class_time.zfill(5)  # needs leading zeros
#     available_classes = []
#     for button in buttons:
#         button_class: Tag | None = button.find_parent(
#             "div", attrs={"class": "card2 round_rect_all_5"}
#         )
#         if button_class is None:
#             continue

#         button_time: Tag | NavigableString | None = button_class.find(
#             "div", attrs={"align": "left", "class": "col"}
#         )
#         button_type: Tag | NavigableString | None = button_class.find(
#             "div", attrs={"align": "left", "class": "col-50"}
#         )
#         if button_time is None or button_type is None:
#             continue

#         available_classes.append(f"{button_type.text.strip()} @ {button_time.text}")
#         if button_time.text.startswith(class_time) and button_type.text.strip() == class_type:
#             LOGGER.info(f"Found button for '{button_type.text.strip()}' @ {button_time.text}")
#             return button
#     raise RuntimeError(
#         f"Unable to find enroll button for class '{class_type}' at {class_time}. Available"
#         f" classes are: {available_classes}"
#     )

def pick_class(classes: list[Class], class_time: str, class_type: str) -> Class:
    for class_ in classes:
        if class_.start != class_time or class_.name != class_type:
            continue
        return class_
    raise RuntimeError(f"Unable to find enroll button for class '{class_type}' at {class_time}.")



# def get_enroll_path(button: Tag) -> str:
#     onclick: str = button.attrs["onclick"]
#     LOGGER.debug(f"Found button onclick action: '{onclick}")
#     button_urls: list[str] = [
#         part for part in onclick.split("'") if part.startswith("php/aulas/marca_aulas.php")
#     ]
#     if len(button_urls) != 1:
#         raise RuntimeError(f"Expecting one page in button, found {len(button_urls)}: {onclick}")
#     return button_urls[0]


# def submit_enroll(path: str) -> None:
#     res: requests.models.Response = SESSION.get(DOMAIN + path, headers=HEADERS, timeout=10)
#     res.raise_for_status()
#     LOGGER.debug(f"Enrolled in class with response: '{res.text}'")
#     soup = BeautifulSoup(res.text, "html.parser")
#     responses: list[str] = re.findall(
#         r"parent\.msg_toast_icon\s\(\"(.+)\",",
#         soup.find_all("script")[-1].text,
#     )
#     if len(responses) != 1:
#         raise RuntimeError(f"Couldn't parse response for enrollment: {res.text}")
#     LOGGER.info(responses[0])


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
