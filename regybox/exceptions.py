"""Define custom exceptions used in the Regybox application.

Note:
    The RegyboxBaseError class serves as the base class for all Regybox-specific
    exceptions. The other exception classes inherit from RegyboxBaseError and
    provide specific error messages.
"""


class RegyboxBaseError(Exception):
    """Base exception class for Regybox errors.

    This exception serves as the base class for all Regybox-specific exceptions.
    """


class RegyboxLoginError(RegyboxBaseError):
    """Exception raised when a login error occurs."""

    def __init__(self) -> None:
        super().__init__("Unable to log in")


class UnparseableError(RegyboxBaseError):
    """Exception raised when an error occurs during parsing of a web page."""


class RegyboxTimeoutError(RegyboxBaseError):
    """Exception raised when an enrollment timeout occurs."""

    def __init__(self, timeout_secs: int, *, time_to_enroll: str | None = None) -> None:
        if time_to_enroll:
            message = (
                f"Enrollment for class opens in {time_to_enroll}, which is more than allowed"
                f" maximum of {timeout_secs} seconds"
            )
        else:
            message = f"Timed out waiting for enrollment to open after {timeout_secs} seconds"
        super().__init__(message)


class UnplannedClassError(RegyboxBaseError):
    """Exception raised when a class is not planned on the user's calendar."""

    def __init__(self, class_isotime: str) -> None:
        super().__init__(
            f"CrossFit class at {class_isotime} is not scheduled on personal calendar"
        )


class ClassUnenrollableBaseError(RegyboxBaseError):
    """Exception raised when a class is unavailable for enrollment.

    This exception is raised when it is not possible to enroll in CrossFit class
    for any reason.
    """


class ClassNotFoundError(ClassUnenrollableBaseError):
    """Exception raised when a class is not found.

    This exception is raised when a class cannot be found or does not exist.
    """

    def __init__(self, *, class_type: str, class_time: str, class_date: str) -> None:
        super().__init__(f"Unable to find class '{class_type}' at {class_time} on {class_date}")


class ClassNotOpenError(ClassUnenrollableBaseError):
    """Exception raised when a class is not open for enrollment."""

    def __init__(self) -> None:
        super().__init__("Class is not open for enrollment")


class ClassIsOverbookedError(ClassUnenrollableBaseError):
    """Exception raised when a class is overbooked."""

    def __init__(self) -> None:
        super().__init__("Class is overbooked")


class ClassAlreadyEnrolledError(ClassUnenrollableBaseError):
    """Exception raised when a user is already enrolled in a class."""

    def __init__(self) -> None:
        super().__init__("Already enrolled in class")
