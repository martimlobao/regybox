# Regybox Auto-enroller

Automatically enroll in a CrossFit class on the Regybox platform.

This is designed to run as a standalone app that runs on a schedule through GH actions.

## Configuration

The app requires the following environment variables to be set:

- `REGIBOX_USER`: The value for `regybox_user` in the [regybox.pt](https://www.regybox.pt/app/app_nova/index.php) cookie
- `PHPSESSID`: The value for `PHPSESSID` in the [regybox.pt](https://www.regybox.pt/app/app_nova/index.php) cookie
- `CALENDAR_URL`: The .ics URL of the calendar to use for the enrollment

The calendar URL is optional, and is used to check if the user's personal calendar has a CrossFit class planned at the time of the enrollment. If it _does not_, the enrollment is skipped. The calendar must either be public or the URL must be accessible without authentication using the _"Secret address in iCal format"_ provided in Google Calendar.

## Development

This project uses [uv](https://docs.astral.sh/uv/) for dependency management and the `src/` layout for the package code.

- Install dependencies with `uv sync`.
- Run the test suite with `uv run pytest`.
- Lint the code with `make lint` (docformatter, ruff, pylint, bandit, yamllint via uv).
- Type-check the project with `uv run mypy src tests`.
