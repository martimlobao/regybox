# Regybox Auto-Enroller

[![uv](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/uv/main/assets/badge/v0.json)](https://docs.astral.sh/uv/)
[![codecov](https://codecov.io/gh/martimlobao/regybox/graph/badge.svg?branch=main)](https://codecov.io/gh/martimlobao/regybox)

Automatically enroll in a CrossFit class on the Regybox platform.

This project powers a GitHub Action that books a class for you and can send a
confirmation email when it finishes. You can run it on a schedule (for example every
morning) or trigger it manually.

## Usage

### 1. Fetch the Cookie Values from the Regybox Website

1. Open [regybox.pt](https://www.regybox.pt/app/app_nova/index.php) and sign in.
2. Open your browser's developer tools (`Cmd+Option+I` on macOS or `Ctrl+Shift+I` on
   Windows/Linux) and select the **Application** tab.
3. Find the cookies named `PHPSESSID` and `regybox_user`, then copy their values. You
   will store them later as GitHub Action secrets.

![Browser dev tools showing how to copy the PHPSESSID and regybox_user cookies.](./static/cookies.png)

### 2. Create a Repository with the GitHub Action

1. Sign in to GitHub and create a [new **private** repository](https://github.com/new) (any name
   works, for example `regybox`).
2. In the repository, open **Settings → Secrets and variables → Actions** and click
   **New repository secret**. Paste the cookie values from step 1 into:

    - `PHPSESSID`

    - `REGYBOX_USER`

   ![Repository secrets list.](./static/repo-secrets.png)

   > [!NOTE]
   > If you want your calendar to drive enrollments and unenrollments on a 30-minute Cloudflare
   > schedule, use the [Cloudflare calendar sync](#calendar-driven-sync-with-cloudflare) approach
   > instead of a fixed-class GitHub schedule.

3. Add the workflow file at `.github/workflows/regybox.yml` using the example below.
   Update the values under the `with:` section (class time, type, secrets, etc.) so they
   match your preferences.

   ```yaml
   name: Book my Regybox class

   on:
     workflow_dispatch:
     schedule: # 48 hours and 15 minutes in advance for morning classes on weekdays
       # standard time, will be wrong on the last week of march
       - cron: 15 6 * 1-3,11-12 5-6,0-2
       # daylight saving time, will be wrong on the last week of october
       - cron: 15 5 * 4-10 5-6,0-2

   jobs:
     enroll:
       runs-on: ubuntu-latest
       steps:
         - name: Regybox auto enrollment
           uses: martimlobao/regybox@v2
           with:
             class-time: 06:30 # Class start time in HH:MM (24-hour) format
             class-type: WOD Rato # Exact class name as it appears in Regybox
             calendar-event-name: CrossFit # Optional calendar title override; defaults to CrossFit
             class-date-offset-days: 2 # Look this many days ahead when booking
             timeout-seconds: 900 # Maximum seconds to wait for enrollment to open
             phpsessid: ${{ secrets.PHPSESSID }}
             regybox-user: ${{ secrets.REGYBOX_USER }}
             calendar-url: ${{ secrets.CALENDAR_URL }}
             send-email: true
             email-to: ${{ secrets.EMAIL_TO }}
             email-username: ${{ secrets.EMAIL_USERNAME }}
             email-password: ${{ secrets.EMAIL_PASSWORD }}
   ```

4. Adjust the `cron` schedules to control when the workflow runs. Cron expressions follow the
   format `minute hour day-of-month month day-of-week` in **UTC**:
    - The example above (`15 5 * * 1-5`) runs **every weekday at 05:15 UTC**, which is 06:15 in
      Lisbon during standard time.
    - If enrollment opens 48 hours before each class, schedule the job to run **two days before**
      the class start time.
    - Start the job **5–15 minutes before** the signup window opens so the booking begins as soon
      as slots are released.
    - GitHub schedules always use UTC and cannot adjust for daylight saving time. Expect the job
      to shift by an hour when clocks change and update the schedule if needed.
    - Days of the week use numbers (`0` or `7` for Sunday, `1` for Monday, …, `6` for Saturday).
      Use ranges like `1-5` for weekdays.
    - Use [crontab.guru](https://crontab.guru/) to preview the schedule before saving.

### 3. Set Up Email Notifications

1. Decide which email account should send confirmations. If you use Gmail, create an
   [App Password](https://myaccount.google.com/apppasswords) and use it instead of your regular
   password. The sender and recipient can be the same Gmail address.
2. In **Settings → Secrets and variables → Actions**, create secrets for:
    - `EMAIL_USERNAME` — the email address that will send the notification.
    - `EMAIL_PASSWORD` — the password or app password.
    - `EMAIL_TO` — the address that should receive notifications (usually the same as
      `EMAIL_USERNAME` for Gmail).
3. Set `send-email: true` in the workflow file so the action sends confirmation emails.

![Google App Password creation page.](./static/create-app-password.png)

![Generated Google App Password.](./static/app-password.png)

### 4. Set Up Calendar Checks

You can optionally choose to have the auto-enroller check your personal calendar to confirm if
there is a class scheduled at the desired time before attempting to enroll in the class. If no such
class exists on your calendar, the action will fail to enroll in the class. This may be useful if
you are travelling and you do not plan on attending your usual classes: simply delete the classes
you do not wish to attend from your calendar and the auto-enroller will not enroll you
automatically in the class.

> [!IMPORTANT]
> If you have already enrolled in a class and you delete the class from your calendar, the
> auto-enroller **will not** unenroll you automatically from the class.

1. Open your calendar provider and locate the secret `.ics` feed URL for your personal calendar.
   In Google Calendar, open **Settings → Settings for my calendars → Integrate calendar** and copy
   the **Secret address in iCal format**.
2. Store this URL in the repository as the `CALENDAR_URL` secret.
3. If your calendar uses a different title than `CrossFit`, set `calendar-event-name` in the
   workflow. If omitted, the action matches the calendar event title against `CrossFit`.

![Secret Google Calendar address](./static/gcal.png)

> [!IMPORTANT]
> The calendar match is case-insensitive and ignores leading/trailing spaces. By default, the
> action looks for an event whose title matches `CrossFit`.

## Calendar-Driven Sync with Cloudflare

GitHub scheduled workflows can run late. For calendar-driven syncing, use a Cloudflare Worker
Cron Trigger to dispatch the GitHub workflow every 30 minutes instead of relying on GitHub's
schedule queue.

Calendar sync is different from the single-class auto-enroller:

- It looks at your calendar over the next 3 days.
- It maps calendar event titles to Regybox class names using required comma-separated lists that
  you provide.
- It enrolls in mapped classes that are open now or whose enrollment opens in the next 30 minutes.
- It unenrolls from mapped Regybox classes that no longer have a matching calendar event.
- It stores successful enrollments and waitlist placements in Cloudflare KV for 30 days. If you
  manually unenroll from a class, the sync job will not re-enroll you while that cache entry exists.

Add a workflow like this at `.github/workflows/calendar_sync.yml` in the repository that owns your
automation:

```yaml
name: Sync Regybox Calendar

on:
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: false
      lookahead-days:
        default: "3"
      enroll-window-minutes:
        default: "30"
      calendar-event-names:
        required: true
      target-class-types:
        required: true

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: astral-sh/setup-uv@v7
      - name: Sync Regybox enrollments
        env:
          PHPSESSID: ${{ secrets.PHPSESSID }}
          REGYBOX_USER: ${{ secrets.REGYBOX_USER }}
          CALENDAR_URL: ${{ secrets.CALENDAR_URL }}
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CF_KV_NAMESPACE_ID: ${{ secrets.CF_KV_NAMESPACE_ID }}
          CF_KV_API_TOKEN: ${{ secrets.CF_KV_API_TOKEN }}
        run: >
          uv run regybox-sync
          --calendar-event-names '${{ inputs.calendar-event-names }}'
          --target-class-types '${{ inputs.target-class-types }}'
```

`calendar-event-names` is a comma-separated list of calendar titles to sync. `target-class-types`
is a comma-separated list of exact Regybox class names that any of those calendar events may
correspond to:

```text
calendar-event-names: "CrossFit"
target-class-types: "WOD"
```

You can provide more than one value by separating names with commas, for example
`calendar-event-names: "CrossFit, Open Gym"` or `target-class-types: "WOD, Weekend WOD"`.

### Cloudflare Setup

You will configure two separate things:

- GitHub Actions runs the actual Regybox sync and reads/writes Cloudflare KV.
- Cloudflare Workers Cron Triggers only wake up every 30 minutes and dispatch the GitHub workflow.

#### 1. Create the GitHub Workflow

Commit `.github/workflows/calendar_sync.yml` in your automation repository. The workflow in this
repository can be used as-is if your automation repository is this repo.

After the workflow exists on the default branch, open **GitHub → Actions → Sync Regybox Calendar →
Run workflow** once and enter:

- `calendar-event-names`: the calendar titles to sync, for example `CrossFit`.
- `target-class-types`: the exact Regybox class names those calendar events may target, for
  example `WOD` or `WOD, Weekend WOD`.
- `dry-run`: `true` for the first manual run.

The dry run should start the workflow without enrolling or unenrolling anything.

#### 2. Create a Cloudflare KV Namespace

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Go to **Storage & databases → Workers KV**.
3. Click **Create Instance**.
4. Name it something like `regybox-sync-state`.
5. Open the new KV instance and go to the **Metrics** tab.
6. Copy the namespace ID. You will store it in GitHub as `CF_KV_NAMESPACE_ID`.

#### 3. Create a Cloudflare API Token for GitHub Actions

The GitHub sync workflow uses Cloudflare's REST API to read and write KV cache keys.

1. In Cloudflare, go to **Manage account → Account API tokens**.
2. Click **Create Token**.
3. Name it `regybox-github-kv`.
4. Add account-level permissions for **Workers KV Storage: Edit**.
5. Click **Review token**.
6. Click **Create token**.
7. Copy **Account ID** and **Your API Token** from this screen.

In GitHub, open **Settings → Secrets and variables → Actions** and add:

- `CF_ACCOUNT_ID` — the **Account ID** value from Cloudflare.
- `CF_KV_NAMESPACE_ID` — the KV namespace ID from step 2.
- `CF_KV_API_TOKEN` — the **Your API Token** value from Cloudflare.

#### 4. Create a GitHub Token for the Cloudflare Worker

The Worker needs a GitHub token that can call the workflow dispatch endpoint.

1. Open [GitHub fine-grained personal access tokens](https://github.com/settings/personal-access-tokens).
2. Click **Generate new token**.
3. Give the token a clear name, such as `regybox-cloudflare-dispatch`.
4. Choose an expiration. Use **No expiration** if you do not want to rotate this token later.
5. Set **Repository access** to only the repository containing `calendar_sync.yml`.
6. Under repository permissions, set **Actions** to **Read and write**.
7. Generate the token and copy it.

#### 5. Create the Cloudflare Worker

1. In Cloudflare, go to **Compute → Workers & Pages**.
2. Click **Create application**.
3. Click **Start with Hello World!**.
4. Rename the Worker to `regybox-scheduler`.
5. Click **Deploy**.
6. Click **Edit code**.
7. Paste this code into the `worker.js` tab:

```js
export default {
  async scheduled(_event, env, _ctx) {
    const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "regybox-cloudflare-scheduler",
      },
      body: JSON.stringify({
        ref: env.GITHUB_REF || "main",
        inputs: {
          "dry-run": "false",
          "lookahead-days": "3",
          "enroll-window-minutes": "30",
          "calendar-event-names": env.CALENDAR_EVENT_NAMES,
          "target-class-types": env.TARGET_CLASS_TYPES,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub dispatch failed: ${response.status} ${await response.text()}`);
    }
  },
};
```

8. Click **Deploy**.

#### 6. Add Worker Variables and Secrets

Go back to the Worker dashboard and open **Settings → Variables**.

Add these as type **Text**:

- `GITHUB_OWNER` — your GitHub account or organization name.
- `GITHUB_REPO` — the name of the GitHub repository containing `calendar_sync.yml`.
- `GITHUB_WORKFLOW` — workflow file name, usually `calendar_sync.yml`.
- `GITHUB_REF` — branch or tag to dispatch, usually `main`.
- `CALENDAR_EVENT_NAMES` — for example `CrossFit`.
- `TARGET_CLASS_TYPES` — for example `WOD`.

Add this as type **Secret**:

- `GITHUB_TOKEN` — the GitHub fine-grained token from step 4.

After all variables and secrets are set, click **Deploy**.

#### 7. Add the Cron Trigger

Cloudflare Cron Triggers use UTC. To run every 30 minutes:

1. Open the Worker in Cloudflare.
2. Stay in the **Settings** tab.
3. In **Trigger events**, click **Add → Cron triggers**.
4. Open the **Cron expression** tab and paste:

   ```cron
   */30 * * * *
   ```

5. Click **Add**.

Cloudflare says Cron Trigger changes can take several minutes to propagate. Wait up to 15 minutes
before assuming the trigger is broken.

#### 8. Test the Setup

1. In Cloudflare, open the Worker logs.
2. Click **Workers & Pages → regybox-scheduler → Logs**.
3. Temporarily change the Worker variable `GITHUB_REF` only if you want to dispatch a test branch.
4. Either wait for the next 30-minute tick or use Cloudflare's Worker testing tools to invoke the
   scheduled handler.
5. In GitHub, open **Actions → Sync Regybox Calendar** and confirm a new run appears.
6. Start with `dry-run: true` until you see the expected classes in the logs.

Useful references:

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)

## Summary of Secrets

| Secret name          | Required | Description                                                                        |
| -------------------- | :------: | ---------------------------------------------------------------------------------- |
| `PHPSESSID`          |   Yes    | Value of the `PHPSESSID` cookie from regybox.pt.                                   |
| `REGYBOX_USER`       |   Yes    | Value of the `regybox_user` cookie from regybox.pt.                                |
| `EMAIL_USERNAME`     |  Yes\*   | Email address that sends confirmations. Required if `send-email` is `true`.        |
| `EMAIL_PASSWORD`     |  Yes\*   | Password or app password for `EMAIL_USERNAME`. Required if `send-email` is `true`. |
| `EMAIL_TO`           |  Yes\*   | Email address that receives confirmations. Required if `send-email` is `true`.     |
| `CALENDAR_URL`       |    No    | Secret `.ics` feed URL for your calendar. Enables calendar sync.                   |
| `CF_ACCOUNT_ID`      |   Sync   | Cloudflare account ID used by calendar-driven sync.                                |
| `CF_KV_NAMESPACE_ID` |   Sync   | Cloudflare KV namespace ID used by calendar-driven sync.                           |
| `CF_KV_API_TOKEN`    |   Sync   | Cloudflare API token with read/write access to the sync KV namespace.              |

> [!TIP]
> After committing the workflow, open the **Actions** tab and run it once with **Run workflow** to
> confirm the setup. A successful run looks like this:

![Test run success.](./static/enrollment-runs.png)

## Development

This project uses [uv](https://docs.astral.sh/uv/) for dependency management and the `src/` layout for the package code.

- Install dependencies with `uv sync`.
- Run the test suite with `uv run pytest`.
- Lint the code with `make lint` (docformatter, ruff, bandit, yamllint via uv).
- Type-check the project with `uv run pyright` and `uv run ty check`.
