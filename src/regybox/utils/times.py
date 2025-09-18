"""Provide utility functions for time-related operations."""

import datetime


def secs_to_str(seconds: int) -> str:
    """Convert a duration in seconds to a string representation.

    Args:
        seconds: The duration in seconds.

    Returns:
        The string representation of the duration in the format "HH:MM:SS".
    """
    return str(datetime.timedelta(seconds=seconds))
