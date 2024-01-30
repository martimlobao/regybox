import sys

from regybox.common import LOGGER
from regybox.regybox import main

if __name__ == "__main__":
    class_date, class_time, class_type = sys.argv[1:]  # pylint: disable=unbalanced-tuple-unpacking
    try:
        main(class_date=class_date, class_time=class_time, class_type=class_type)
    except RuntimeError as e:
        LOGGER.error(e)
        sys.exit(1)
