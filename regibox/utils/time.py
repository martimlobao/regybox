import datetime


def secs_to_str(seconds: int) -> str:
    return str(datetime.timedelta(seconds=seconds))
