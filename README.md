# Regybox Auto-Enroller

[![uv](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/uv/main/assets/badge/v0.json)](https://docs.astral.sh/uv/)
[![codecov](https://codecov.io/gh/martimlobao/regybox/graph/badge.svg?branch=main)](https://codecov.io/gh/martimlobao/regybox)

![The Worker's status page: green setup and live checks, the last run, and recent activity including an enrollment.](./static/status-page.png)

Automatically enroll in a CrossFit class on the Regybox platform.

Add your classes to your calendar (or delete one to skip a day), and this project
books and cancels the matching Regybox classes for you, optionally emailing you a
confirmation. There are three ways to run it — pick one:

1. **[One-click Cloudflare setup](#recommended-one-click-cloudflare-setup)**
   (recommended): a Cloudflare Worker checks your calendar every half hour and
   books classes directly. Easiest to set up, no fixed schedule to maintain.
2. **[GitHub Action with a fixed schedule](docs/legacy-setups.md#alternative-github-action-with-a-fixed-schedule)**:
   books the same class at the same time every week. No Cloudflare account needed.
3. **[Cloudflare Worker → GitHub Actions dispatch](docs/legacy-setups.md#advanced-calendar-driven-sync-with-cloudflare-and-github)**
   (advanced): the original calendar-driven setup, kept for existing users.

The last two are documented in [docs/legacy-setups.md](docs/legacy-setups.md).

## Recommended: One-Click Cloudflare Setup

Everything runs in a free Cloudflare account that you own: your credentials stay
with you, and there is no server to maintain. You need a Cloudflare account and a
GitHub account (both free — GitHub is only used to store your copy of the code).

### 1. Copy Your Regybox Cookies

1. Open [regybox.pt](https://www.regybox.pt/app/app_nova/index.php) and sign in.
2. Open your browser's developer tools (`Cmd+Option+I` on macOS or `Ctrl+Shift+I` on
   Windows/Linux) and select the **Application** tab.
3. Find the cookies named `PHPSESSID` and `regybox_user` and copy their values
   somewhere handy — you will paste them during the deploy step.

![Browser dev tools showing how to copy the PHPSESSID and regybox_user cookies.](./static/cookies.png)

### 2. Copy Your Secret Calendar Link

1. In [Google Calendar settings](https://calendar.google.com/calendar/r/settings),
   pick your calendar under **Settings for my calendars** and open
   **Integrate calendar**.
2. Copy the **Secret address in iCal format**.

![Secret Google Calendar address](./static/gcal.png)

### 3. Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/martimlobao/regybox/tree/main/cloudflare/regybox-scheduler)

1. Click the button above and sign in to Cloudflare (and GitHub, when asked).
2. Fill in the values it asks for (each field explains where its value comes from):
    - `PHPSESSID` and `REGYBOX_USER` — the cookie values from step 1.
    - `CALENDAR_URL` — the secret calendar link from step 2.
    - `CLASS_MAP` — which calendar events book which Regybox classes. Each rule is
      `Calendar event = Regybox class`; separate several rules with `;` and give
      backup class names with commas. Examples:

      ```text
      CrossFit = WOD
      Weightlifting = Weightlifting Rato; CrossFit = WOD, Weekend WOD
      ```

      The second example books `Weightlifting Rato` for calendar events titled
      "Weightlifting", and for events titled "CrossFit" tries `WOD` first and
      `Weekend WOD` if there is no `WOD` at that time.

   ![The Create a Worker screen prompting for the KV namespace, cookie values, calendar link, and CLASS_MAP.](./static/deploy-screen.png)

3. Click **Create and deploy**. Cloudflare creates the storage and the half-hourly
   schedule automatically. You can skip everything under **Advanced settings** —
   the "Variable name/value" fields there are build-time settings and do not
   affect the running Worker.

To change any of these values later, open the Worker in the Cloudflare dashboard
and edit them under **Settings → Variables and Secrets** — the status page (step 5)
always shows the booking rules currently in effect. Your dashboard values stay in
place when the Worker is redeployed; in particular, updates do not replace your
`CLASS_MAP`, cookies, calendar URL, or email settings.

### Automatic Updates

The Worker copy created in your GitHub account checks for Regybox updates every
day and installs them automatically. Cloudflare then deploys the update for you.
Your Worker name, storage, variables, and secrets stay yours; only the Regybox
code and its shared scheduling configuration are updated. A small monthly
heartbeat keeps the update workflow enabled even when GitHub would otherwise
disable scheduled workflows for an inactive public repository.

To update immediately, open your GitHub copy, choose **Actions → Regybox
Automatic Updates → Run workflow**. If you have changed the code yourself and
want to maintain it independently, disable that workflow in the **Actions** tab.

The workflow's **Commit and deploy the update** step pushes directly to the
repository's default branch. If you add branch protection that requires pull
request approval or status checks before every push, allow this workflow to
bypass that rule or automatic updates will fail.

### 4. Optional: Turn on Email Notifications

You will get an email when a class is booked or cancelled, or when something needs
your attention (like an expired login). Runs that change nothing stay silent. Failure
emails include a private, hard-to-guess link to a sanitized incident report with the
details needed for troubleshooting. Reports expire after seven days and never contain
cookies, passwords, calendar links, full booking URLs, or URL query tokens.

1. If you use Gmail, create an [App Password](https://myaccount.google.com/apppasswords)
   — a special password just for this Worker; your normal password never leaves
   Google. Give it any name (for example `regybox`) and copy the generated value.

   ![Google App Password creation page.](./static/create-app-password.png)

   ![Generated Google App Password.](./static/app-password.png)

2. Open the Worker in the Cloudflare dashboard and go to
   **Settings → Variables and Secrets**. Add three secrets:
    - `EMAIL_USERNAME` — the Gmail address that sends the notification.
    - `EMAIL_PASSWORD` — the App Password from the previous step.
    - `EMAIL_TO` — the address that receives notifications (usually the same as
      `EMAIL_USERNAME`).

3. Refresh the status page (step 5) — it should now say "Email notifications are on".

### 5. Check That It Works

Open your Worker's page (Cloudflare dashboard → **Workers & Pages** →
**regybox-scheduler** → the `workers.dev` link). It shows a plain-English
checklist: whether your login works, whether your calendar is reachable, how many
upcoming classes it found, and what the last run did. If something is red, the
page tells you how to fix it.

From then on it books any class that appears on your calendar (usually the moment
enrollment opens) and cancels a booking if you delete the event. When your
Regybox login eventually expires, the status page and the notification email will
tell you — copy fresh cookie values from regybox.pt and update `PHPSESSID` under
**Settings → Variables and Secrets**, then you're back in business.

### Seeing What It's Doing

- **Status page** (the `workers.dev` link): the **Recent activity** section lists the
  last bookings, cancellations, and failures with timestamps, and **Last run** shows
  what the most recent half-hourly check did — including "nothing to do".
- **Failure email link**: opens a read-only incident report containing safe parser and
  operation details. The link works for seven days. Open the status page once after
  deployment so scheduled runs know the Worker's public address; alternatively set
  `STATUS_URL` to that address under **Settings → Variables and Secrets**.
- **Cloudflare logs**: in the dashboard, open the Worker → **Logs** to see every run
  (searchable, kept for a few days). Every log line the scheduler writes starts with
  `regybox:`, for example `regybox: enroll WOD on 2026-07-14 at 06:30 -> success`.
- **Live tail** (for the technically inclined): `bunx wrangler tail <worker-name>`
  streams runs as they happen.

## Development

This project uses [uv](https://docs.astral.sh/uv/) for dependency management and the `src/` layout for the package code.

- Install dependencies with `uv sync`.
- Run the test suite with `uv run pytest`.
- Lint the code with `make lint` (docformatter, ruff, bandit, yamllint via uv).
- Type-check the project with `uv run pyright` and `uv run ty check`.
