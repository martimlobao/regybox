import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from regybox.common import TIMEZONE
from regybox.exceptions import UserAlreadyEnrolledError
from regybox.sync import (
    KV_TTL_SECONDS,
    CloudflareKVStore,
    build_class_map,
    class_cache_key,
    sync_calendar,
)

CALENDAR_EVENT_NAMES = "Crossfit"
TARGET_CLASS_TYPES = "WOD Rato"


def _class(  # noqa: PLR0913
    *,
    name: str = "WOD Rato",
    date: str = "2026-06-18",
    start: str = "06:30",
    is_open: bool = True,
    time_to_enroll: int | None = None,
    user_is_enrolled: bool = False,
    user_is_waitlisted: bool = False,
    enroll_url: str | None = (
        "https://www.regybox.pt/app/app_nova/php/aulas/marca_aulas.php?"
        "id_aula=63049&data=2026-06-18&source=mes&ano=2026&id_rato=2120&"
        "x=0e0e5e2b0fed2e699ba91b3d6506"
    ),
    unenroll_url: str | None = None,
) -> MagicMock:
    mock_class = MagicMock()
    mock_class.name = name
    mock_class.date = date
    mock_class.start = start
    mock_class.is_open = is_open
    mock_class.time_to_enroll = time_to_enroll
    mock_class.user_is_enrolled = user_is_enrolled
    mock_class.user_is_waitlisted = user_is_waitlisted
    mock_class.enroll_url = enroll_url
    mock_class.unenroll_url = unenroll_url
    mock_class.enroll.return_value = "Inscrito com sucesso"
    mock_class.unenroll.return_value = "Cancelado"
    return mock_class


class _CalendarEvent:
    def __init__(self, summary: str | None, when: datetime.datetime | datetime.date) -> None:
        self.summary = summary
        self.when = when

    def get(self, key: str) -> str | None:
        if key == "SUMMARY":
            return self.summary
        return None

    def __getitem__(self, key: str) -> SimpleNamespace:
        if key != "DTSTART":
            raise KeyError(key)
        return SimpleNamespace(dt=self.when)


def test_class_cache_key_prefers_generic_x_and_ignores_box_specific_params() -> None:
    first = (
        "https://www.regybox.pt/app/app_nova/php/aulas/marca_aulas.php?"
        "id_aula=63049&data=2026-06-17&source=mes&ano=2026&id_rato=2120&"
        "x=0e0e5e2b0fed2e699ba91b3d6506"
    )
    reordered = (
        "https://www.regybox.pt/app/app_nova/php/aulas/marca_aulas.php?"
        "x=0e0e5e2b0fed2e699ba91b3d6506&id_rato=9999&data=2026-06-17&"
        "id_aula=63049&ano=2026&source=mes"
    )

    assert class_cache_key(first) == class_cache_key(reordered)
    assert class_cache_key(first) == (
        "regybox-sync:v1:enroll:x:data=2026-06-17:id_aula=63049:x=0e0e5e2b0fed2e699ba91b3d6506"
    )


def test_class_cache_key_falls_back_to_canonical_hash_without_x() -> None:
    first = (
        "https://www.regybox.pt/app/app_nova/php/aulas/marca_aulas.php?"
        "id_aula=63049&data=2026-06-17&id_rato=2120"
    )
    second = (
        "https://www.regybox.pt/app/app_nova/php/aulas/marca_aulas.php?"
        "id_rato=9999&data=2026-06-17&id_aula=63049"
    )

    assert class_cache_key(first) == class_cache_key(second)
    assert class_cache_key(first).startswith("regybox-sync:v1:enroll:hash:")


def test_build_class_map_requires_custom_args() -> None:
    with pytest.raises(ValueError, match="calendar-event-names"):
        build_class_map(None, TARGET_CLASS_TYPES)
    with pytest.raises(ValueError, match="target-class-types"):
        build_class_map(CALENDAR_EVENT_NAMES, None)

    assert build_class_map("Crossfit, Open Gym", "WOD Rato, Weekend WOD Rato") == {
        "crossfit": ("WOD Rato", "Weekend WOD Rato"),
        "open gym": ("WOD Rato", "Weekend WOD Rato"),
    }

    with pytest.raises(ValueError, match="calendar-event-names"):
        build_class_map(" , ", TARGET_CLASS_TYPES)
    with pytest.raises(ValueError, match="target-class-types"):
        build_class_map(CALENDAR_EVENT_NAMES, " , ")


def test_cloudflare_kv_store_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CF_ACCOUNT_ID", "account")
    monkeypatch.setenv("CF_KV_NAMESPACE_ID", "namespace")
    monkeypatch.setenv("CF_KV_API_TOKEN", "api-token")

    store = CloudflareKVStore.from_env()

    assert store.account_id == "account"
    assert store.namespace_id == "namespace"
    assert store.api_token == "api-token"  # noqa: S105


def test_cloudflare_kv_store_from_env_raises_when_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CF_KV_NAMESPACE_ID", raising=False)
    monkeypatch.delenv("CF_KV_API_TOKEN", raising=False)

    with pytest.raises(ValueError, match="CF_ACCOUNT_ID"):
        CloudflareKVStore.from_env()


def test_cloudflare_kv_store_seen_reads_existing_and_missing_keys() -> None:
    session = MagicMock()
    missing_response = MagicMock()
    missing_response.status_code = 404
    existing_response = MagicMock()
    existing_response.status_code = 200
    existing_response.raise_for_status = MagicMock()
    session.get.side_effect = [missing_response, existing_response]
    store = CloudflareKVStore(
        account_id="account",
        namespace_id="namespace",
        api_token="api-token",  # noqa: S106
        session=session,
    )

    assert store.seen("missing") is False
    assert store.seen("existing") is True
    existing_response.raise_for_status.assert_called_once_with()


def test_cloudflare_kv_store_writes_success_with_30_day_ttl() -> None:
    session = MagicMock()
    put_response = MagicMock()
    put_response.raise_for_status = MagicMock()
    session.put.return_value = put_response
    api_token = "test-api-token"  # noqa: S105
    store = CloudflareKVStore(
        account_id="account",
        namespace_id="namespace",
        api_token=api_token,
        session=session,
    )

    store.mark_success("regybox-sync:v1:enroll:x:key")

    session.put.assert_called_once()
    assert session.put.call_args.kwargs["params"] == {"expiration_ttl": str(KV_TTL_SECONDS)}
    assert session.put.call_args.kwargs["headers"]["Authorization"] == f"Bearer {api_token}"


def test_sync_calendar_enrolls_open_calendar_class_and_caches_success() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    wod = _class()
    store = MagicMock()
    store.seen.return_value = False

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=store,
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    wod.enroll.assert_called_once_with()
    store.mark_success.assert_called_once()
    assert result.enrolled == 1
    assert result.skipped_cached == 0


def test_sync_calendar_handles_already_enrolled_response_and_caches_success() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    wod = _class()

    wod.enroll.side_effect = UserAlreadyEnrolledError()
    store = MagicMock()
    store.seen.return_value = False

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=store,
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    wod.enroll.assert_called_once_with()
    store.mark_success.assert_called_once()
    assert result.enrolled == 1


def test_sync_calendar_skips_cached_calendar_class() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    wod = _class()
    store = MagicMock()
    store.seen.return_value = True

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=store,
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    wod.enroll.assert_not_called()
    store.mark_success.assert_not_called()
    assert result.skipped_cached == 1


def test_sync_calendar_does_not_cache_failed_enrollment() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    wod = _class()
    wod.enroll.side_effect = RuntimeError("website error")
    store = MagicMock()
    store.seen.return_value = False

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        with pytest.raises(RuntimeError, match="website error"):
            sync_calendar(
                store=store,
                calendar_event_names=CALENDAR_EVENT_NAMES,
                target_class_types=TARGET_CLASS_TYPES,
                now=now,
            )

    store.mark_success.assert_not_called()


def test_sync_calendar_unenrolls_mapped_class_without_calendar_event() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    enrolled = _class(
        user_is_enrolled=True,
        enroll_url=None,
        unenroll_url=(
            "https://www.regybox.pt/app/app_nova/php/aulas/cancela_aula.php?"
            "id_aula=63049&data=2026-06-18&x=0e0e5e2b0fed2e699ba91b3d6506"
        ),
    )

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[enrolled]),
    ):
        calendar_cls.return_value.interval.return_value = []
        result = sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    enrolled.unenroll.assert_called_once_with()
    assert result.unenrolled == 1


def test_sync_calendar_waits_and_refetches_class_opening_inside_enroll_window() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    pending = _class(is_open=False, time_to_enroll=0, enroll_url=None)
    opened = _class(is_open=True, time_to_enroll=None)
    store = MagicMock()
    store.seen.return_value = False

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", side_effect=[[], [pending], [opened]]),
        patch("regybox.sync.time.sleep") as sleep,
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=store,
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
            lookahead_days=1,
        )

    sleep.assert_not_called()
    opened.enroll.assert_called_once_with()
    pending.enroll.assert_not_called()
    assert result.enrolled == 1
    assert result.skipped_not_ready == 0


def test_sync_calendar_does_not_unenroll_mapped_class_outside_sync_window() -> None:
    now = datetime.datetime(2026, 6, 17, 12, 0, tzinfo=TIMEZONE)
    earlier_today = _class(
        date="2026-06-17",
        start="06:30",
        user_is_enrolled=True,
        enroll_url=None,
        unenroll_url=(
            "https://www.regybox.pt/app/app_nova/php/aulas/cancela_aula.php?"
            "id_aula=63049&data=2026-06-17&x=0e0e5e2b0fed2e699ba91b3d6506"
        ),
    )

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[earlier_today]),
    ):
        calendar_cls.return_value.interval.return_value = []
        result = sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
            lookahead_days=1,
        )

    earlier_today.unenroll.assert_not_called()
    assert result.unenrolled == 0


def test_sync_calendar_leaves_unmapped_enrolled_class_alone() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    yoga = _class(name="Yoga", user_is_enrolled=True, enroll_url=None)

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[yoga]),
    ):
        calendar_cls.return_value.interval.return_value = []
        result = sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    yoga.unenroll.assert_not_called()
    assert result.unenrolled == 0


def test_sync_calendar_skips_not_open_class_outside_enroll_window() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    wod = _class(is_open=False, time_to_enroll=1801)

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    wod.enroll.assert_not_called()
    assert result.skipped_not_ready == 1


def test_sync_calendar_skips_open_class_without_enroll_url() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    wod = _class(enroll_url=None)

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    wod.enroll.assert_not_called()
    assert result.skipped_not_ready == 1


def test_sync_calendar_skips_when_calendar_event_has_no_matching_class() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 8, 30, tzinfo=TIMEZONE))
    wod = _class(start="06:30")

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    wod.enroll.assert_not_called()
    assert result.calendar_events == 1
    assert result.enrolled == 0


def test_sync_calendar_skips_already_enrolled_matching_calendar_class() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    wod = _class(user_is_enrolled=True)

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    wod.enroll.assert_not_called()
    wod.unenroll.assert_not_called()
    assert result.enrolled == 0
    assert result.unenrolled == 0


def test_sync_calendar_ignores_unmapped_blank_and_all_day_events() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    naive_when = datetime.datetime.combine(datetime.date(2026, 6, 18), datetime.time(6, 30))
    events = [
        _CalendarEvent(None, datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE)),
        _CalendarEvent("Yoga", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE)),
        _CalendarEvent("Crossfit", datetime.date(2026, 6, 18)),
        _CalendarEvent("Crossfit", naive_when),
    ]
    wod = _class()

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod]),
    ):
        calendar_cls.return_value.interval.return_value = events
        result = sync_calendar(
            store=MagicMock(seen=MagicMock(return_value=False)),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
        )

    assert result.calendar_events == 1
    assert result.enrolled == 1


def test_sync_calendar_rejects_non_positive_options() -> None:
    with pytest.raises(ValueError, match="lookahead-days"):
        sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            lookahead_days=0,
        )
    with pytest.raises(ValueError, match="enroll-window-minutes"):
        sync_calendar(
            store=MagicMock(),
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            enroll_window_minutes=0,
        )


def test_sync_calendar_requires_configured_calendar() -> None:
    with patch("regybox.sync.Calendar") as calendar_cls:
        calendar_cls.return_value.calendar = None
        with pytest.raises(ValueError, match="CALENDAR_URL"):
            sync_calendar(
                store=MagicMock(),
                calendar_event_names=CALENDAR_EVENT_NAMES,
                target_class_types=TARGET_CLASS_TYPES,
            )


def test_sync_calendar_dry_run_does_not_mutate() -> None:
    now = datetime.datetime(2026, 6, 17, 17, 0, tzinfo=TIMEZONE)
    event = _CalendarEvent("Crossfit", datetime.datetime(2026, 6, 18, 6, 30, tzinfo=TIMEZONE))
    wod = _class()
    enrolled = _class(user_is_enrolled=True, start="07:30", enroll_url=None)
    store = MagicMock()
    store.seen.return_value = False

    with (
        patch("regybox.sync.Calendar") as calendar_cls,
        patch("regybox.sync.get_classes", return_value=[wod, enrolled]),
    ):
        calendar_cls.return_value.interval.return_value = [event]
        result = sync_calendar(
            store=store,
            calendar_event_names=CALENDAR_EVENT_NAMES,
            target_class_types=TARGET_CLASS_TYPES,
            now=now,
            dry_run=True,
        )

    wod.enroll.assert_not_called()
    enrolled.unenroll.assert_not_called()
    store.mark_success.assert_not_called()
    assert result.enrolled == 1
    assert result.unenrolled == 1
