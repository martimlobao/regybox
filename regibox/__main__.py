import sys

from regibox.regibox import LOGGER, main

if __name__ == "__main__":
    class_date, class_time = sys.argv[1:]
    try:
        main(class_date, class_time)
    except RuntimeError as e:
        LOGGER.error(e)
        sys.exit(1)
