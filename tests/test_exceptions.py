"""Tests for structured, user-facing exception metadata."""

import pytest

from regybox.exceptions import (
    ClassIsOverbookedError,
    ClassNotFoundError,
    ClassNotOpenError,
    NoClassesFoundError,
    RegyboxBaseError,
    RegyboxLoginError,
    RegyboxTimeoutError,
    UnparseableError,
    UnplannedClassError,
    UserAlreadyEnrolledError,
)


@pytest.mark.parametrize(
    ("error", "error_code", "title"),
    [
        (RegyboxLoginError(), "login_error", "Unable to log in to Regybox"),
        (
            RegyboxTimeoutError(900),
            "timeout_waiting_for_enrollment",
            "Timed out waiting for enrollment",
        ),
        (
            RegyboxTimeoutError(900, time_to_enroll="00:45:00"),
            "timeout_waiting_for_enrollment",
            "Enrollment window opens later than expected",
        ),
        (
            UnplannedClassError("2026-02-01T06:30:00"),
            "class_not_in_calendar",
            "Class not found on your calendar",
        ),
        (
            ClassNotFoundError(class_type="WOD Rato", class_time="06:30", class_date="2026-02-01"),
            "class_not_found",
            "Requested class was not found",
        ),
        (
            NoClassesFoundError(class_date="2026-02-01"),
            "no_classes_found",
            "No classes found for the selected date",
        ),
        (ClassNotOpenError(), "class_not_open", "Enrollment is not open yet"),
        (ClassIsOverbookedError(), "class_overbooked", "Class and waitlist are full"),
        (UserAlreadyEnrolledError(), "already_enrolled", "Already enrolled"),
        (
            UnparseableError(),
            "unparseable_response",
            "Regybox returned an unexpected response",
        ),
    ],
)
def test_exception_user_payload(error: RegyboxBaseError, error_code: str, title: str) -> None:
    payload = error.to_user_payload()

    assert payload["error_code"] == error_code
    assert payload["user_title"] == title
    assert payload["user_message"]
    assert payload["technical_message"] == str(error)
    assert isinstance(payload["user_next_steps"], list)
    assert payload["user_next_steps"]


def test_exception_technical_message_is_preserved() -> None:
    timeout_error = RegyboxTimeoutError(120)
    parse_error = UnparseableError("Bad parser state")

    assert str(timeout_error) == "Timed out waiting for enrollment to open after 120 seconds"
    assert str(parse_error) == "Bad parser state"
