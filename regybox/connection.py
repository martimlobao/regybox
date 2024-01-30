import os
import re
from urllib.parse import urljoin

import requests
from dotenv import find_dotenv, load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from regybox.exceptions import RegyboxConnectionError
from regybox.utils.singleton import Singleton

load_dotenv(dotenv_path=find_dotenv(usecwd=True))

USER: str = os.environ["REGYBOX_USER"]
DOMAIN: str = "https://www.regybox.pt/app/app_nova/"
HEADERS: dict[str, str] = {
    "Accept": "text/html, */*; q=0.01",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": f'PHPSESSID={os.environ["PHPSESSID"]}; regybox_boxes=%2A{USER}; regybox_user={USER}',
    "DNT": "1",
    "Host": "www.regybox.pt",
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


class RegyboxSession(requests.Session, metaclass=Singleton):
    def __init__(self, *, user: str = USER) -> None:
        super().__init__()
        adapter: HTTPAdapter = HTTPAdapter(max_retries=Retry(connect=10, backoff_factor=0.5))
        self.mount("http://", adapter)
        self.mount("https://", adapter)
        self.set_session(user=user)  # only called once since this is a singleton

    def set_session(self, *, user: str) -> None:
        self.get(
            urljoin(DOMAIN, "set_session.php"),
            headers=HEADERS,
            params=self.get_session_params(user=user),
        ).raise_for_status()

    @staticmethod
    def get_session_params(*, user: str) -> dict[str, str]:
        return {
            "z": user,
            "y": f"*{user}",
            "ignore": "regybox.pt/app/app",
        }


def get_url_html(url: str, *, params: dict | None = None) -> str:
    """Retrieve the HTML content of a given URL.

    Args:
        url: The URL to retrieve the HTML content from.
        params: Optional parameters to include in the request.

    Returns:
        The HTML content of the URL as a string.

    Raises:
        requests.HTTPError: If the request to the URL fails.
    """
    if not params:
        params = {}
    res: requests.models.Response = RegyboxSession().get(
        url, headers=HEADERS, params=params, timeout=10
    )
    res.raise_for_status()
    if re.findall(r"app/app_nova/login.php", res.text):
        raise RegyboxConnectionError("Unable to log in")
    return res.text


def get_classes_params(timestamp: int, *, user: str) -> dict[str, str]:
    """Generate the parameters for retrieving class information.

    Args:
        timestamp: The timestamp in milliseconds.
        user: The user identifier.

    Returns:
        A dictionary of parameters for the class retrieval request.
    """
    return {
        "valor1": str(timestamp),
        "type": "",
        "source": "mes",
        "scroll": "s",
        "z": user,
    }


def get_classes_html(timestamp: int, user: str = USER) -> str:
    """Retrieve the HTML content of the classes page.

    Args:
        timestamp: The timestamp in milliseconds.
        user: The user identifier.

    Returns:
        The HTML content of the classes page as a string.
    """
    return get_url_html(
        urljoin(DOMAIN, "php/aulas/aulas.php"),
        params=get_classes_params(timestamp, user=user),
    )
