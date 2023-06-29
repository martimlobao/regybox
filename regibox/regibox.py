import datetime
import logging
import os
import re
import time

import pytz
import requests
from bs4 import BeautifulSoup
from bs4.element import NavigableString, Tag
from dotenv import find_dotenv, load_dotenv

TIMEZONE: pytz.BaseTzInfo = pytz.timezone("Europe/Lisbon")
START: datetime.datetime = datetime.datetime.now(TIMEZONE)
LOGGER: logging.Logger = logging.getLogger("REGIBOX")
logging.basicConfig(
    format="%(asctime)s %(levelname)s [%(name)s] [%(filename)s:%(lineno)d] - %(message)s",
    level=logging.INFO,
)
load_dotenv(dotenv_path=find_dotenv(usecwd=True))
DOMAIN: str = "https://www.regibox.pt/app/app_nova/"
HEADERS: dict[str, str] = {
    "Accept": "text/html, */*; q=0.01",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9,pt;q=0.8,pt-PT;q=0.7",
    "Connection": "keep-alive",
    "Cookie": os.environ["COOKIE"],
    "DNT": "1",
    "Host": "www.regibox.pt",
    "Referer": "https://www.regibox.pt/app/app_nova/index.php",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"
        " Chrome/114.0.0.0 Safari/537.36"
    ),
    "X-Requested-With": "XMLHttpRequest",
    "sec-ch-ua": '"Not.A/Brand";v="8", "Chromium";v="114"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
}


def get_enroll_params(timestamp: int) -> dict[str, str]:
    return {
        "valor1": str(timestamp),
        "type": "",
        "source": "mes",
        "scroll": "s",
        "z": "",
    }


def get_enroll_buttons(year: int, month: int, day: int) -> list[Tag]:
    timestamp: int = int(datetime.datetime(year, month, day, tzinfo=TIMEZONE).timestamp() * 1000)
    res: requests.models.Response = requests.get(
        f"{DOMAIN}php/aulas/aulas.php",
        params=get_enroll_params(timestamp),
        headers=HEADERS,
        timeout=10,
    )
    res.raise_for_status()
    soup: BeautifulSoup = BeautifulSoup(res.text, "html.parser")
    buttons: list[Tag] = soup.find_all("button")
    LOGGER.debug(
        "Found all buttons:\n\t{}".format(
            "\n\t".join([f"{button.decode()}" for button in buttons]),
        ),
    )
    buttons = [button for button in buttons if button.text == "INSCREVER"]
    LOGGER.debug(
        "Found enrollment buttons:\n\t{}".format(
            "\n\t".join([f"{button.decode()}" for button in buttons]),
        ),
    )
    return buttons


def pick_button(buttons: list[Tag], class_time: str, class_type: str) -> Tag:
    available_classes = []
    for button in buttons:
        button_class: Tag | None = button.find_parent(
            "div", attrs={"class": "card2 round_rect_all_5"}
        )
        if button_class is None:
            continue

        button_time: Tag | NavigableString | None = button_class.find(
            "div", attrs={"align": "left", "class": "col"}
        )
        button_type: Tag | NavigableString | None = button_class.find(
            "div", attrs={"align": "left", "class": "col-50"}
        )
        if button_time is None or button_type is None:
            continue

        available_classes.append(f"{button_type.text.strip()} @ {button_time.text}")
        if button_time.text.startswith(class_time) and button_type.text.strip() == class_type:
            LOGGER.info(f"Found button for '{button_type.text.strip()}' @ {button_time.text}")
            return button
    raise RuntimeError(
        f"Unable to find enroll button for class '{class_type}' at {class_time}. Available"
        f" classes are: {available_classes}"
    )


def get_enroll_path(button: Tag) -> str:
    onclick: str = button.attrs["onclick"]
    LOGGER.debug(f"Found button onclick action: '{onclick}")
    button_urls: list[str] = [
        part for part in onclick.split("'") if part.startswith("php/aulas/marca_aulas.php")
    ]
    if len(button_urls) != 1:
        raise RuntimeError(f"Expecting one page in button, found {len(button_urls)}: {onclick}")
    return button_urls[0]


def submit_enroll(path: str) -> None:
    res: requests.models.Response = requests.get(DOMAIN + path, headers=HEADERS, timeout=10)
    res.raise_for_status()
    LOGGER.debug(f"Enrolled in class with response: '{res.text}'")
    soup = BeautifulSoup(res.text, "html.parser")
    responses: list[str] = re.findall(
        r"parent\.msg_toast_icon\s\(\"(.+)\",",
        soup.find_all("script")[-1].text,
    )
    if len(responses) != 1:
        raise RuntimeError(f"Couldn't parse response for enrollment: {res.text}")
    LOGGER.info(responses[0])


def main(
    class_day: str | None = None, class_time: str = "12:00", class_type: str = "WOD RATO"
) -> None:
    LOGGER.info(f"Started at {START.isoformat()}")
    if not class_day:
        date: datetime.datetime = datetime.datetime.now(TIMEZONE) + datetime.timedelta(days=2)
    else:
        date = datetime.datetime.strptime(class_day, "%Y-%m-%d").replace(tzinfo=TIMEZONE)
    wait: int = 3  # 3 seconds between calls
    timeout: int = 600  # try for 10 minutes
    while (datetime.datetime.now(TIMEZONE) - START).total_seconds() < timeout:
        buttons: list[Tag] = get_enroll_buttons(date.year, date.month, date.day)
        try:
            button: Tag = pick_button(buttons, class_time, class_type)
        except RuntimeError:
            LOGGER.info(
                f"No button found for {class_type} at {date.date().isoformat()} on"
                f" {class_time}, retrying in {wait} seconds."
            )
            time.sleep(wait)
        else:
            break
    else:
        raise RuntimeError(
            f"Timed out waiting for class {class_type} at {date.date().isoformat()} on"
            f" {class_time}, terminating."
        )
    path: str = get_enroll_path(button)
    submit_enroll(path)
    LOGGER.info(f"Enrolled at {path}")
    LOGGER.info(f"Runtime: {(datetime.datetime.now(TIMEZONE) - START).total_seconds():.3f}")
