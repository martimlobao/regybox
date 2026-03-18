"""Tests for the connection module."""

from unittest.mock import MagicMock, patch

import pytest
import requests

from regybox.connection import (
    HEADERS,
    RegyboxSession,
    get_classes_html,
    get_classes_params,
    get_url_html,
)
from regybox.exceptions import RegyboxLoginError
from regybox.utils.singleton import Singleton


def test_get_classes_params() -> None:
    """get_classes_params returns expected dict for a timestamp and user."""
    params = get_classes_params(1234567890000, user="testuser")
    assert params["valor1"] == "1234567890000"
    assert params["z"] == "testuser"
    assert params["source"] == "mes"
    assert "type" in params


def test_get_url_html_raises_on_login_redirect() -> None:
    """get_url_html raises RegyboxLoginError when response contains login."""
    mock_response = MagicMock()
    mock_response.raise_for_status = MagicMock()
    mock_response.text = "https://www.regybox.pt/app/app_nova/login.php"
    mock_session = MagicMock()
    mock_session.get.return_value = mock_response
    with (
        patch("regybox.connection.RegyboxSession", return_value=mock_session),
        pytest.raises(RegyboxLoginError),
    ):
        get_url_html("https://example.com/page")


def test_get_url_html_returns_text_on_success() -> None:
    """get_url_html returns response text when no login redirect."""
    mock_response = MagicMock()
    mock_response.raise_for_status = MagicMock()
    mock_response.text = "<html>classes</html>"
    with patch("regybox.connection.RegyboxSession") as mock_session_cls:
        mock_session = MagicMock()
        mock_session.get.return_value = mock_response
        mock_session_cls.return_value = mock_session
        result = get_url_html("https://example.com/page")
    assert result == "<html>classes</html>"


def test_get_classes_html_calls_get_url_html_with_params() -> None:
    """get_classes_html calls get_url_html with aulas.php and params."""
    with patch(
        "regybox.connection.get_url_html", return_value='<div class="filtro0"></div>'
    ) as mock_get:
        get_classes_html(1234567890000, user="testuser")
    mock_get.assert_called_once()
    call_kw = mock_get.call_args[1]
    assert "params" in call_kw
    assert call_kw["params"]["valor1"] == "1234567890000"
    assert call_kw["params"]["z"] == "testuser"


def test_regybox_session_initializes_mounts_and_session(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_session_init(_self: requests.Session) -> None:
        return None

    monkeypatch.setattr(requests.Session, "__init__", fake_session_init)
    mount = MagicMock()
    set_session = MagicMock()
    monkeypatch.setattr(RegyboxSession, "mount", mount)
    monkeypatch.setattr(RegyboxSession, "set_session", set_session)
    if RegyboxSession in Singleton._instances:
        del Singleton._instances[RegyboxSession]
    try:
        RegyboxSession(user="testuser")
    finally:
        if RegyboxSession in Singleton._instances:
            del Singleton._instances[RegyboxSession]

    assert mount.call_count == 2
    assert mount.call_args_list[0].args[0] == "http://"
    assert mount.call_args_list[1].args[0] == "https://"
    set_session.assert_called_once_with(user="testuser")


def test_regybox_session_set_session_calls_get(monkeypatch: pytest.MonkeyPatch) -> None:
    response = MagicMock()
    response.raise_for_status = MagicMock()
    session: RegyboxSession = object.__new__(RegyboxSession)
    get = MagicMock(return_value=response)
    monkeypatch.setattr(session, "get", get)

    RegyboxSession.set_session(session, user="testuser")

    get.assert_called_once_with(
        "https://www.regybox.pt/app/app_nova/set_session.php",
        headers=HEADERS,
        params=RegyboxSession.get_session_params(user="testuser"),
    )
    response.raise_for_status.assert_called_once_with()


def test_regybox_session_get_session_params() -> None:
    assert RegyboxSession.get_session_params(user="testuser") == {
        "z": "testuser",
        "y": "*testuser",
        "ignore": "regybox.pt/app/app",
    }
