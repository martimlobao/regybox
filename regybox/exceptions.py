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


class RegyboxConnectionError(RegyboxError):
    """Exception raised when a connection error occurs.

    This exception is raised when there is an error in establishing or
    maintaining a connection.
    """
