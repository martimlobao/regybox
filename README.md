# Regybox Auto-enroller

Automatically enroll in a CrossFit class on the Regybox platform.

This is designed to run as a standalone app that runs on a schedule through GH actions.

## Configuration

The app requires the following environment variables to be set:

- `REGIBOX_USER`: The value for `regybox_user` in the [regybox.pt](https://regybox.pt) cookie
- `PHPSESSID`: The value for `PHPSESSID` in the [regybox.pt](https://regybox.pt) cookie
- `CALENDAR_URL`: The .ics URL of the calendar to use for the enrollment

The calendar URL is optional, and is used to check if the user's personal calendar has a CrossFit class planned at the time of the enrollment. If it _does not_, the enrollment is skipped. The calendar must either be public or the URL must be accessible without authentication using the _"Secret address in iCal format"_ provided in Google Calendar.
