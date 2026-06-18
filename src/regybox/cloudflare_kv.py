"""Write Regybox scheduler state to Cloudflare KV from GitHub Actions."""

from __future__ import annotations

import json
import os
import urllib.parse
from dataclasses import dataclass

import requests

KV_TTL_SECONDS = 2_592_000


@dataclass(frozen=True)
class CloudflareKVConfig:
    """Cloudflare KV REST API configuration."""

    account_id: str
    namespace_id: str
    api_token: str

    @classmethod
    def from_env(cls) -> CloudflareKVConfig:
        """Read Cloudflare KV configuration from environment variables.

        Returns:
            Cloudflare KV API configuration.

        Raises:
            ValueError: If any required environment variable is missing.
        """
        env_values = {
            "CF_ACCOUNT_ID": os.environ.get("CF_ACCOUNT_ID", "").strip(),
            "CF_KV_NAMESPACE_ID": os.environ.get("CF_KV_NAMESPACE_ID", "").strip(),
            "CF_KV_API_TOKEN": os.environ.get("CF_KV_API_TOKEN", "").strip(),
        }
        missing = [key for key, value in env_values.items() if not value]
        if missing:
            raise ValueError(f"Missing Cloudflare KV environment values: {', '.join(missing)}")
        return cls(
            account_id=env_values["CF_ACCOUNT_ID"],
            namespace_id=env_values["CF_KV_NAMESPACE_ID"],
            api_token=env_values["CF_KV_API_TOKEN"],
        )


def write_state(
    *,
    config: CloudflareKVConfig,
    cache_key: str,
    state: str,
    class_date: str,
    class_time: str,
    class_type: str,
    calendar_fingerprint: str,
) -> None:
    """Write one scheduler state entry to Cloudflare KV."""
    payload = {
        "state": state,
        "classDate": class_date,
        "classTime": class_time,
        "classType": class_type,
        "calendarFingerprint": calendar_fingerprint,
    }
    response = requests.put(
        (
            "https://api.cloudflare.com/client/v4/accounts/"
            f"{config.account_id}/storage/kv/namespaces/{config.namespace_id}/values/"
            f"{urllib.parse.quote(cache_key, safe='')}"
        ),
        headers={"Authorization": f"Bearer {config.api_token}"},
        params={"expiration_ttl": str(KV_TTL_SECONDS)},
        data=json.dumps(payload, sort_keys=True),
        timeout=30,
    )
    response.raise_for_status()


def main() -> None:
    """Entry point used by the composite action after terminal operations.

    Raises:
        ValueError: If ``REGYBOX_OPERATION`` is not supported.
    """
    cache_key = os.environ.get("CACHE_KEY", "").strip()
    if not cache_key:
        return
    operation = os.environ.get("REGYBOX_OPERATION", "enroll").strip()
    if operation not in {"enroll", "unenroll"}:
        raise ValueError("REGYBOX_OPERATION must be either 'enroll' or 'unenroll'.")
    state = "unenrolled" if operation == "unenroll" else "enrolled"
    try:
        write_state(
            config=CloudflareKVConfig.from_env(),
            cache_key=cache_key,
            state=state,
            class_date=os.environ.get("CLASS_DATE", "").strip(),
            class_time=os.environ.get("CLASS_TIME", "").strip(),
            class_type=os.environ.get("CLASS_TYPE", "").strip(),
            calendar_fingerprint=os.environ.get("CALENDAR_FINGERPRINT", "").strip(),
        )
    except (ValueError, requests.RequestException) as exc:
        print(f"Warning: Cloudflare KV cache update failed: {exc}")


if __name__ == "__main__":
    main()
