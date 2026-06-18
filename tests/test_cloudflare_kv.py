import json
from unittest.mock import Mock, patch

import pytest

from regybox import cloudflare_kv
from regybox.cloudflare_kv import KV_TTL_SECONDS, CloudflareKVConfig, write_state

FAKE_CREDENTIAL = "not-a-real-value"


def test_cloudflare_kv_config_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CF_ACCOUNT_ID", "account")
    monkeypatch.setenv("CF_KV_NAMESPACE_ID", "namespace")
    monkeypatch.setenv("CF_KV_API_TOKEN", FAKE_CREDENTIAL)

    assert CloudflareKVConfig.from_env() == CloudflareKVConfig(
        account_id="account",
        namespace_id="namespace",
        api_token=FAKE_CREDENTIAL,
    )


def test_cloudflare_kv_config_requires_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CF_KV_NAMESPACE_ID", raising=False)
    monkeypatch.delenv("CF_KV_API_TOKEN", raising=False)

    with pytest.raises(ValueError, match="CF_ACCOUNT_ID"):
        CloudflareKVConfig.from_env()


def test_write_state_sends_ttl_and_payload() -> None:
    response = Mock()
    with patch("regybox.cloudflare_kv.requests.put", return_value=response) as put:
        write_state(
            config=CloudflareKVConfig(
                account_id="account",
                namespace_id="namespace",
                api_token=FAKE_CREDENTIAL,
            ),
            cache_key="regybox:v1:key",
            state="enrolled",
            class_date="2026-06-18",
            class_time="06:30",
            class_type="WOD",
            calendar_fingerprint="uid:start",
        )

    put.assert_called_once()
    _, kwargs = put.call_args
    assert kwargs["headers"] == {"Authorization": f"Bearer {FAKE_CREDENTIAL}"}
    assert kwargs["params"] == {"expiration_ttl": str(KV_TTL_SECONDS)}
    assert json.loads(kwargs["data"]) == {
        "calendarFingerprint": "uid:start",
        "classDate": "2026-06-18",
        "classTime": "06:30",
        "classType": "WOD",
        "state": "enrolled",
    }
    response.raise_for_status.assert_called_once()


def test_cloudflare_kv_main_skips_empty_cache_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CACHE_KEY", raising=False)
    with patch("regybox.cloudflare_kv.write_state") as mock_write_state:
        cloudflare_kv.main()

    mock_write_state.assert_not_called()


def test_cloudflare_kv_main_writes_unenrolled_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CACHE_KEY", "regybox:v1:key")
    monkeypatch.setenv("REGYBOX_OPERATION", "unenroll")
    monkeypatch.setenv("CLASS_DATE", "2026-06-18")
    monkeypatch.setenv("CLASS_TIME", "06:30")
    monkeypatch.setenv("CLASS_TYPE", "WOD")
    monkeypatch.setenv("CALENDAR_FINGERPRINT", "uid:start")
    with (
        patch("regybox.cloudflare_kv.CloudflareKVConfig.from_env") as from_env,
        patch("regybox.cloudflare_kv.write_state") as mock_write_state,
    ):
        cloudflare_kv.main()

    mock_write_state.assert_called_once_with(
        config=from_env.return_value,
        cache_key="regybox:v1:key",
        state="unenrolled",
        class_date="2026-06-18",
        class_time="06:30",
        class_type="WOD",
        calendar_fingerprint="uid:start",
    )
