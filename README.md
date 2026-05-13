# FIXR Timepiece Ticket Monitor

Lightweight Node.js monitor that checks the FIXR event page for Timepiece ticket availability and sends an email when tickets first appear to become available.

It is designed to run on GitHub Actions every 10 minutes, so no server is required.

## How It Works

- Fetches the configured FIXR Timepiece page.
- Looks for ticket availability signals in page text, buttons, links, and embedded JSON.
- Persists the previous result in `state.json`.
- Sends one email only when availability changes from `false` to `true`.
- In GitHub Actions, state is persisted through the Actions cache at `.monitor-state/state.json`.

## Project Structure

```text
src/
  checkTickets.js
  emailer.js
  state.json
.github/workflows/
  monitor.yml
.env.example
package.json
```

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local `.env` file:

```bash
cp .env.example .env
```

Edit `.env`:

```env
EVENT_URL=https://fixr.co/organiser/timepiece
STATE_FILE=src/state.json
EMAIL_TO=person@example.com,friend@example.com
EMAIL_FROM=alerts@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=alerts@example.com
SMTP_PASS=your-smtp-password
```

Run one check:

```bash
npm start
```

## GitHub Actions Setup

Add these repository secrets in GitHub under **Settings → Secrets and variables → Actions → Secrets**:

- `EMAIL_TO` comma-separated recipient list
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

Optionally add this repository variable under **Settings → Secrets and variables → Actions → Variables**:

- `EVENT_URL` defaults to `https://fixr.co/organiser/timepiece`

The workflow runs every 10 minutes and can also be started manually from the Actions tab.

## Alert Behaviour

An email is sent only on this transition:

```text
available: false -> true
```

No email is sent for:

```text
available: true -> true
available: false -> false
```

If sending the email fails, the monitor does not mark tickets as available, so the next run can retry the alert.

## Notes

FIXR may block simple automated HTTP requests or change its page structure. The monitor uses browser-like request headers and multiple detection strategies, including event links on the Timepiece organiser page. If you know the exact event URL, set `EVENT_URL` to that event-specific page. If the page starts returning persistent `403` responses in GitHub Actions, point `EVENT_URL` at a stable FIXR API, widget endpoint, or page that exposes the ticket state.

Credentials are read only from environment variables or GitHub Secrets. The monitor logs availability signals for debugging but never logs SMTP credentials.
