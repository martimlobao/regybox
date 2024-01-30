class RegyboxError(Exception):
    """Base exception class for Regybox errors.

    This exception serves as the base class for all Regybox-specific
    exceptions.
    """


class ClassNotFoundError(RegyboxError):
    """Exception raised when a class is not found.

    This exception is raised when a class cannot be found or does not
    exist.
    """
