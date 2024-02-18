import sys

from regybox.common import LOGGER
from regybox.exceptions import RegyboxBaseError
from regybox.regybox import main

if __name__ == "__main__":
    class_date, class_time, class_type = sys.argv[1:]
    try:
        main(class_date=class_date, class_time=class_time, class_type=class_type)
    except RegyboxBaseError as e:
        LOGGER.error(e)
        sys.exit(1)
