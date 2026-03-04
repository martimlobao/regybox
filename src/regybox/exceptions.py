"""Define custom exceptions used in the Regybox application.

Note:
    RegyboxBaseError is the base class for all Regybox-specific
    exceptions. Other exception classes inherit from it and provide specific
    error messages.
"""

from typing import TypedDict

REGYBOX_USER_ERROR_PREFIX: str = "REGYBOX_USER_ERROR_JSON="
USER_ERROR_PREFIX: str = REGYBOX_USER_ERROR_PREFIX


class UserErrorPayload(TypedDict):
    """Machine-readable payload used in GitHub Action notifications."""

    error_code: str
    user_title: str
    user_message: str
    user_next_steps: list[str]
    technical_message: str


class RegyboxBaseError(Exception):
    """Base exception class for Regybox errors.

    This exception serves as the base class for all Regybox-specific exceptions
    while carrying plain-English data for notifications.
    """

    error_code: str
    user_title: str
    user_message: str
    user_next_steps: tuple[str, ...]

    def __init__(
        self,
        technical_message: str,
        *,
        error_code: str = "unknown_error",
        user_title: str = "Unexpected enrollment issue",
        user_message: str = "The enrollment could not be completed.",
        user_next_steps: tuple[str, ...] = (
            "Retry the workflow once.",
            "If it fails again, share the technical details with support.",
        ),
    ) -> None:
        """Initialize a new instance of the RegyboxBaseError class."""
        super().__init__(technical_message)
        self.error_code = error_code
        self.user_title = user_title
        self.user_message = user_message
        self.user_next_steps = user_next_steps

    def to_user_payload(self) -> UserErrorPayload:
        """Serialize this exception for machine-readable logs.

        Returns:
            User-facing metadata represented as a JSON-friendly dictionary.
        """
        return {
            "error_code": self.error_code,
            "user_title": self.user_title,
            "user_message": self.user_message,
            "user_next_steps": list(self.user_next_steps),
            "technical_message": str(self),
        }


class RegyboxLoginError(RegyboxBaseError):
    """Exception raised when a login error occurs."""

    def __init__(self) -> None:
        """Initialize a new instance of the RegyboxLoginError class."""
        super().__init__(
            "Unable to log in",
            error_code="login_error",
            user_title="Unable to log in to Regybox",
            user_message=(
                "The saved login session was rejected, so the automation could not access "
                "your account."
            ),
            user_next_steps=(
                "Sign in to regybox.pt and copy fresh PHPSESSID and regybox_user cookies.",
                "Update the GitHub secrets PHPSESSID and REGYBOX_USER.",
                "Run the workflow again.",
            ),
        )


class UnparseableError(RegyboxBaseError):
    """Exception raised when an error occurs during parsing of a web page."""

    def __init__(self, message: str = "") -> None:
        """Initialize a new instance of the UnparseableError class."""
        super().__init__(
            message or "Unable to parse HTML",
            error_code="unparseable_response",
            user_title="Regybox returned an unexpected response",
            user_message=(
                "The website answered, but its response format was different from what the "
                "automation expects."
            ),
            user_next_steps=(
                "Retry once in case this was temporary.",
                "If it keeps failing, share the technical details with support.",
            ),
        )


class RegyboxTimeoutError(RegyboxBaseError):
    """Exception raised when an enrollment timeout occurs."""

    def __init__(self, timeout_secs: int, *, time_to_enroll: str | None = None) -> None:
        """Initialize a new instance of the RegyboxTimeoutError class."""
        if time_to_enroll:
            message = (
                f"Enrollment for class opens in {time_to_enroll}, which is more than allowed"
                f" maximum of {timeout_secs} seconds"
            )
            user_title = "Enrollment window opens later than expected"
            user_message = (
                f"The class opens in {time_to_enroll}, but the workflow is configured to wait "
                f"only {timeout_secs} seconds."
            )
        else:
            message = f"Timed out waiting for enrollment to open after {timeout_secs} seconds"
            user_title = "Timed out waiting for enrollment"
            user_message = (
                f"The workflow waited {timeout_secs} seconds, but enrollment never opened."
            )
        super().__init__(
            message,
            error_code="timeout_waiting_for_enrollment",
            user_title=user_title,
            user_message=user_message,
            user_next_steps=(
                "Start the workflow closer to the opening time for enrollment.",
                "Increase timeout-seconds if your schedule requires a longer wait.",
                "Retry the workflow.",
            ),
        )


class UnplannedClassError(RegyboxBaseError):
    """Exception raised when a class is not planned on the user's calendar."""

    def __init__(self, class_isotime: str) -> None:
        """Initialize a new instance of the UnplannedClassError class."""
        super().__init__(
            f"CrossFit class at {class_isotime} is not scheduled on personal calendar",
            error_code="class_not_in_calendar",
            user_title="Class not found on your calendar",
            user_message=(
                f"The automation expected a CrossFit event at {class_isotime}, but none was "
                "found in your configured calendar."
            ),
            user_next_steps=(
                "Add or restore the class event in your calendar and retry.",
                "If you want to skip calendar validation, remove CALENDAR_URL from the workflow.",
            ),
        )


class ClassUnenrollableBaseError(RegyboxBaseError):
    """Exception raised when a class is unavailable for enrollment.

    This exception is raised when it is not possible to enroll in a CrossFit
    class for any reason.
    """

    def __init__(self, message: str = "Class is unavailable for enrollment") -> None:
        """Initialize a generic unenrollable-class error."""
        super().__init__(
            message,
            error_code="class_unenrollable",
            user_title="Class is not available for enrollment",
            user_message=(
                "The requested class could not be enrolled at this time due to booking rules."
            ),
            user_next_steps=(
                "Confirm the class still exists at the requested date and time.",
                "Retry the workflow closer to the class opening time.",
            ),
        )


class ClassNotFoundError(ClassUnenrollableBaseError):
    """Exception raised when a class is not found.

    This exception is raised when a class cannot be found or does not exist.
    """

    def __init__(self, *, class_type: str, class_time: str, class_date: str) -> None:
        """Initialize a new instance of the ClassNotFoundError class."""
        super().__init__(f"Unable to find class '{class_type}' at {class_time} on {class_date}")
        self.error_code = "class_not_found"
        self.user_title = "Requested class was not found"
        self.user_message = (
            f"No class matching '{class_type}' at {class_time} was found on {class_date}."
        )
        self.user_next_steps = (
            "Check the class name and time in your workflow configuration.",
            "Confirm the class exists in Regybox for that date.",
            "Retry the workflow.",
        )


class NoClassesFoundError(ClassUnenrollableBaseError):
    """Exception raised when no classes are found."""

    def __init__(self, *, class_date: str) -> None:
        """Initialize a new instance of the NoClassesFoundError class."""
        super().__init__(f"No classes found on {class_date}")
        self.error_code = "no_classes_found"
        self.user_title = "No classes found for the selected date"
        self.user_message = f"Regybox did not list any classes on {class_date}."
        self.user_next_steps = (
            "Check if the gym has published that day's schedule.",
            "Confirm the selected date offset is correct in the workflow.",
            "Retry later when classes are available.",
        )


class ClassNotOpenError(ClassUnenrollableBaseError):
    """Exception raised when a class is not open for enrollment."""

    def __init__(self) -> None:
        """Initialize a new instance of the ClassNotOpenError class."""
        super().__init__("Class is not open for enrollment")
        self.error_code = "class_not_open"
        self.user_title = "Enrollment is not open yet"
        self.user_message = "The class exists, but enrollment is still closed."
        self.user_next_steps = (
            "Wait until enrollment opens and run the workflow again.",
            "Start the workflow closer to the enrollment opening time.",
        )


class ClassIsOverbookedError(ClassUnenrollableBaseError):
    """Exception raised when a class is overbooked."""

    def __init__(self) -> None:
        """Initialize a new instance of the ClassIsOverbookedError class."""
        super().__init__("Class is overbooked")
        self.error_code = "class_overbooked"
        self.user_title = "Class and waitlist are full"
        self.user_message = "The class is overbooked, so no additional spots are available."
        self.user_next_steps = (
            "Try a different class time.",
            "Retry later in case a spot becomes available.",
        )


class UserAlreadyEnrolledError(ClassUnenrollableBaseError):
    """Exception raised when a user is already enrolled in a class."""

    def __init__(self) -> None:
        """Initialize a new instance of the UserAlreadyEnrolledError class."""
        super().__init__("User already enrolled in class")
        self.error_code = "already_enrolled"
        self.user_title = "Already enrolled"
        self.user_message = "You are already enrolled in this class."
        self.user_next_steps = ("No action needed.",)
