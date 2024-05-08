python_tests(
    extra_env_vars=[
        "PHPSESSID=42",
        "REGYBOX_USER=1337",
        "CALENDAR_URL=https://raw.githubusercontent.com/collective/icalendar/v5.0.11/src/icalendar/tests/calendars/timezone_rdate.ics",
    ],
    overrides={
        "test_classes.py": {
            "dependencies": ["tests/html_examples:html-resources"],
        },
        "test_regybox.py": {
            "dependencies": ["//:pyproject-toml"],
        },
    },
)
