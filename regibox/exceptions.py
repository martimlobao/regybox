class RegiboxError(Exception):
    """Base exception class for Regibox errors.

    This exception serves as the base class for all Regibox-specific
    exceptions.
    """


class ClassNotFoundError(Exception):
    """Exception raised when a class is not found.

    This exception is raised when a class cannot be found or does not
    exist.
    """
