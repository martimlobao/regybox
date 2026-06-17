"""Calendar-driven Regybox enrollment synchronization."""

import datetime
import hashlib
import os
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import parse_qsl, quote, urlencode, urlparse

import icalendar
import requests

from regybox.cal import Calendar
from regybox.classes import Class, get_classes
from regybox.common import LOGGER, TIMEZONE
from regybox.exceptions import UserAlreadyEnrolledError

KV_TTL_SECONDS: int = 30 * 24 * 60 * 60
KV_API_BASE_URL: str = "https://api.cloudflare.com/client/v4"
HTTP_NOT_FOUND: int = 404
VOLATILE_CACHE_PARAMS: frozenset[str] = frozenset({"id_rato", "box", "plano"})


class SyncStore(Protocol):
    """State store for successful automatic enrollment attempts."""

    def seen(self, key: str) -> bool:
        """Return whether a successful enrollment key is stored."""
        ...

    def mark_success(self, key: str) -> None:
        """Persist a successful enrollment key."""
        ...


@dataclass(frozen=True)
class SyncResult:
    """Summary of one sync pass."""

    calendar_events: int = 0
    enrolled: int = 0
    unenrolled: int = 0
    skipped_cached: int = 0
    skipped_not_ready: int = 0


@dataclass(frozen=True)
class PlannedClass:
    """A calendar event translated into one or more Regybox class names."""

    starts_at: datetime.datetime
    class_names: tuple[str, ...]


class CloudflareKVStore:
    """Cloudflare KV-backed sync state store."""

    def __init__(
        self,
        *,
        account_id: str,
        namespace_id: str,
        api_token: str,
        session: requests.Session | None = None,
    ) -> None:
        """Initialize a Cloudflare KV store."""
        self.account_id = account_id
        self.namespace_id = namespace_id
        self.api_token = api_token
        self.session = session if session is not None else requests.Session()

    @classmethod
    def from_env(cls) -> "CloudflareKVStore":
        """Create a Cloudflare KV store from environment variables.

        Returns:
            A Cloudflare KV store configured from environment variables.

        Raises:
            ValueError: If any required Cloudflare environment variable is
                missing.
        """
        missing = [
            name
            for name in ("CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_KV_API_TOKEN")
            if not os.environ.get(name)
        ]
        if missing:
            raise ValueError(f"Missing Cloudflare KV environment variables: {', '.join(missing)}")
        return cls(
            account_id=os.environ["CF_ACCOUNT_ID"],
            namespace_id=os.environ["CF_KV_NAMESPACE_ID"],
            api_token=os.environ["CF_KV_API_TOKEN"],
        )

    def _value_url(self, key: str) -> str:
        encoded_key = quote(key, safe="")
        return (
            f"{KV_API_BASE_URL}/accounts/{self.account_id}/storage/kv/namespaces/"
            f"{self.namespace_id}/values/{encoded_key}"
        )

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_token}"}

    def seen(self, key: str) -> bool:
        """Return whether the key already exists in KV."""
        response = self.session.get(self._value_url(key), headers=self._headers, timeout=10)
        if response.status_code == HTTP_NOT_FOUND:
            return False
        response.raise_for_status()
        return True

    def mark_success(self, key: str) -> None:
        """Store a successful automatic enrollment marker with a 30-day TTL."""
        response = self.session.put(
            self._value_url(key),
            data="1",
            headers=self._headers,
            params={"expiration_ttl": str(KV_TTL_SECONDS)},
            timeout=10,
        )
        response.raise_for_status()


def build_class_map(
    calendar_event_names: str | None,
    target_class_types: str | None,
) -> dict[str, tuple[str, ...]]:
    """Build calendar-summary-to-Regybox-class mappings from CSV arguments.

    Returns:
        A case-folded mapping of calendar summary to Regybox class names.
    """
    event_names = _parse_csv_arg(calendar_event_names, arg_name="calendar-event-names")
    class_types = tuple(_parse_csv_arg(target_class_types, arg_name="target-class-types"))
    return {event_name.casefold(): class_types for event_name in event_names}


def _parse_csv_arg(value: str | None, *, arg_name: str) -> list[str]:
    if value is None:
        raise ValueError(f"{arg_name} must be provided")
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if not parts:
        raise ValueError(f"{arg_name} must include at least one value")
    return parts


def class_cache_key(enroll_url: str) -> str:
    """Build a generic, stable cache key for a Regybox enrollment URL.

    Returns:
        A stable cache key derived from generic URL parameters.
    """
    parsed_url = urlparse(enroll_url)
    params = dict(parse_qsl(parsed_url.query, keep_blank_values=True))
    if params.get("x"):
        key_parts = [
            f"{name}={params[name]}" for name in ("data", "id_aula", "x") if params.get(name)
        ]
        return f"regybox-sync:v1:enroll:x:{':'.join(key_parts)}"

    canonical_params = [
        (name, value)
        for name, value in parse_qsl(parsed_url.query, keep_blank_values=True)
        if name not in VOLATILE_CACHE_PARAMS
    ]
    canonical_params.sort()
    canonical = f"{parsed_url.path}?{urlencode(canonical_params)}"
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"regybox-sync:v1:enroll:hash:{digest}"


def sync_calendar(
    *,
    store: SyncStore,
    calendar_event_names: str | None = None,
    target_class_types: str | None = None,
    lookahead_days: int = 3,
    enroll_window_minutes: int = 30,
    dry_run: bool = False,
    now: datetime.datetime | None = None,
) -> SyncResult:
    """Sync Regybox enrollments to mapped calendar events.

    Returns:
        Summary counts for the sync pass.

    Raises:
        ValueError: If numeric options are not positive or mapping arguments
            are invalid.
    """
    if lookahead_days <= 0:
        raise ValueError("lookahead-days must be positive")
    if enroll_window_minutes <= 0:
        raise ValueError("enroll-window-minutes must be positive")

    started_at = now if now is not None else datetime.datetime.now(TIMEZONE)
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=TIMEZONE)
    ends_at = started_at + datetime.timedelta(days=lookahead_days)
    class_map = build_class_map(calendar_event_names, target_class_types)
    calendar = Calendar()
    if not calendar.calendar:
        raise ValueError("calendar sync requires CALENDAR_URL to be configured")
    planned_classes = _planned_classes(calendar, started_at, ends_at, class_map)
    classes_by_date = _classes_by_date(started_at, ends_at)

    unenrolled = 0
    enroll_window_seconds = enroll_window_minutes * 60
    enrolled, skipped_cached, skipped_not_ready = _sync_enrollments(
        planned_classes,
        classes_by_date=classes_by_date,
        store=store,
        enroll_window_seconds=enroll_window_seconds,
        dry_run=dry_run,
    )

    for class_ in _mapped_enrolled_classes(classes_by_date, class_map):
        if _has_matching_calendar_event(class_, planned_classes):
            continue
        LOGGER.info("Unenrolling from %s on %s at %s", class_.name, class_.date, class_.start)
        if not dry_run:
            class_.unenroll()
        unenrolled += 1

    result = SyncResult(
        calendar_events=len(planned_classes),
        enrolled=enrolled,
        unenrolled=unenrolled,
        skipped_cached=skipped_cached,
        skipped_not_ready=skipped_not_ready,
    )
    LOGGER.info(
        "Sync result: calendar_events=%s enrolled=%s unenrolled=%s skipped_cached=%s"
        " skipped_not_ready=%s",
        result.calendar_events,
        result.enrolled,
        result.unenrolled,
        result.skipped_cached,
        result.skipped_not_ready,
    )
    return result


def _sync_enrollments(
    planned_classes: list[PlannedClass],
    *,
    classes_by_date: dict[datetime.date, list[Class]],
    store: SyncStore,
    enroll_window_seconds: int,
    dry_run: bool,
) -> tuple[int, int, int]:
    enrolled = 0
    skipped_cached = 0
    skipped_not_ready = 0

    for planned in planned_classes:
        class_ = _find_planned_regybox_class(planned, classes_by_date)
        if class_ is None:
            LOGGER.info(
                "No mapped Regybox class found for calendar event at %s",
                planned.starts_at.isoformat(),
            )
            continue
        enrollment = _enrollment_decision(
            class_,
            store=store,
            enroll_window_seconds=enroll_window_seconds,
        )
        if enrollment == "already_enrolled":
            continue
        if enrollment == "not_ready":
            skipped_not_ready += 1
            continue
        if enrollment == "cached":
            skipped_cached += 1
            continue
        LOGGER.info("Enrolling in %s on %s at %s", class_.name, class_.date, class_.start)
        if not dry_run:
            try:
                class_.enroll()
            except UserAlreadyEnrolledError:
                LOGGER.info("Already enrolled in class")
            store.mark_success(enrollment)
        enrolled += 1

    return enrolled, skipped_cached, skipped_not_ready


def _planned_classes(
    calendar: Calendar,
    start: datetime.datetime,
    end: datetime.datetime,
    class_map: dict[str, tuple[str, ...]],
) -> list[PlannedClass]:
    events = calendar.interval(start, end)
    planned: list[PlannedClass] = []
    for event in events:
        summary = _event_summary(event)
        if summary is None:
            continue
        class_names = class_map.get(summary.casefold())
        if class_names is None:
            continue
        starts_at = _event_start(event)
        if starts_at is None:
            continue
        planned.append(PlannedClass(starts_at=starts_at, class_names=class_names))
    return planned


def _event_summary(event: icalendar.cal.Event) -> str | None:
    summary = event.get("SUMMARY")
    if summary is None:
        return None
    normalized = str(summary).strip()
    return normalized or None


def _event_start(event: icalendar.cal.Event) -> datetime.datetime | None:
    dt = event["DTSTART"].dt
    if isinstance(dt, datetime.datetime):
        if dt.tzinfo is None:
            return dt.replace(tzinfo=TIMEZONE)
        return dt.astimezone(TIMEZONE)
    return None


def _classes_by_date(
    start: datetime.datetime,
    end: datetime.datetime,
) -> dict[datetime.date, list[Class]]:
    dates: list[datetime.date] = []
    current = start.date()
    while current <= end.date():
        dates.append(current)
        current += datetime.timedelta(days=1)

    classes_by_date: dict[datetime.date, list[Class]] = {}
    for date in dates:
        classes_by_date[date] = get_classes(date.year, date.month, date.day)
    return classes_by_date


def _find_planned_regybox_class(
    planned: PlannedClass,
    classes_by_date: dict[datetime.date, list[Class]],
) -> Class | None:
    class_date = planned.starts_at.date()
    class_time = planned.starts_at.strftime("%H:%M")
    mapped_names = {name.casefold() for name in planned.class_names}
    for class_ in classes_by_date.get(class_date, []):
        if class_.start == class_time and class_.name.casefold() in mapped_names:
            return class_
    return None


def _class_is_enrollable_now(class_: Class, enroll_window_seconds: int) -> bool:
    if class_.is_open:
        return True
    return class_.time_to_enroll is not None and class_.time_to_enroll <= enroll_window_seconds


def _enrollment_decision(
    class_: Class,
    *,
    store: SyncStore,
    enroll_window_seconds: int,
) -> str:
    """Return an enrollment action token or skip reason."""
    if class_.user_is_enrolled or class_.user_is_waitlisted:
        return "already_enrolled"
    if not _class_is_enrollable_now(class_, enroll_window_seconds):
        return "not_ready"
    if class_.enroll_url is None:
        return "not_ready"
    cache_key = class_cache_key(class_.enroll_url)
    if store.seen(cache_key):
        return "cached"
    return cache_key


def _mapped_enrolled_classes(
    classes_by_date: dict[datetime.date, list[Class]],
    class_map: dict[str, tuple[str, ...]],
) -> list[Class]:
    mapped_names = {name.casefold() for names in class_map.values() for name in names}
    enrolled: list[Class] = []
    seen: set[tuple[str, str, str]] = set()
    for classes in classes_by_date.values():
        for class_ in classes:
            if class_.name.casefold() not in mapped_names:
                continue
            if class_.user_is_enrolled or class_.user_is_waitlisted:
                signature = (class_.date, class_.start, class_.name.casefold())
                if signature in seen:
                    continue
                seen.add(signature)
                enrolled.append(class_)
    return enrolled


def _has_matching_calendar_event(
    class_: Class,
    planned_classes: list[PlannedClass],
) -> bool:
    class_name = class_.name.casefold()
    for planned in planned_classes:
        if class_name not in {name.casefold() for name in planned.class_names}:
            continue
        if (
            planned.starts_at.date().isoformat() == class_.date
            and planned.starts_at.strftime("%H:%M") == class_.start
        ):
            return True
    return False
