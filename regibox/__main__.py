from regibox.regibox import LOGGER, main

if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        LOGGER.exception(e)
