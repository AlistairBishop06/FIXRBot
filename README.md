# FIXR Timepiece Ticket Monitor

Lightweight Node.js monitor that checks the FIXR event page for Timepiece ticket availability and sends an email the moment tickets first appear to become available.

**This project only watches for availability and sends a notification email. It does not purchase tickets, complete checkout, bypass CAPTCHAs, or automate any FIXR account actions.**

The monitor runs as a single **continuous Node.js process**, intended to be kept alive 24/7 on a Linux VPS under [PM2](https://pm2.keymetrics.io/). It no longer relies on GitHub Actions for production monitoring — see [Alternative: GitHub Actions](#alternative-github-actions-manual-testing-only) if you still want an occasional manual check from CI.

## Project Structure

```text
src/
  monitor.js         # long-running loop — the production entry point (npm start)
  checkTickets.js     # FIXR availability detection (unchanged logic) + one-shot CLI
  emailer.js          # sends the availability notification email
  logger.js           # tiny timestamped console logger
  state.json           # last-known availability, used to detect false -> true transitions
.github/workflows/
  monitor.yml          # optional, manual-trigger-only dev/test workflow
.env.example
package.json
```

## How It Works

```text
              Linux VPS
                 │
                 ▼
                PM2
                 │
                 ▼
          src/monitor.js  ──────────────┐
                 │                       │ waits POLL_INTERVAL_MS,
                 ▼                       │ then loops back
        src/checkTickets.js              │
                 │                       │
                 ▼                       │
               FIXR                      │
                 │                       │
                 ▼                       │
        availability result              │
                 │                       │
          ┌──────┴──────┐                │
          │             │                │
       changed       unchanged            │
          │             │                │
          ▼             ▼                │
  src/emailer.js       (skip email)      │
          │             │                │
          ▼             │                │
        email           │                │
          │             │                │
          └──────┬──────┘                │
                 ▼                       │
           save state.json               │
                 │                       │
                 └───────────────────────┘
```

- Polls the configured FIXR JSON data endpoint (`EVENT_DATA_URL`) when available; falls back to the HTML page (`EVENT_URL`) otherwise, and to a reader proxy (`READER_BASE_URL`) if FIXR responds with `403`.
- Looks for ticket availability signals in the FIXR JSON payload, page text, buttons, links, and embedded JSON — this detection logic is unchanged from the original implementation.
- Persists the last known result in `src/state.json`.
- Sends one email only on the transition `available: false -> true`. No email is sent for `true -> true` or `false -> false`.
- A failed FIXR request (timeout, HTTP error, malformed JSON, etc.) is **never** treated as "tickets unavailable" — the previous state is preserved and the monitor retries on the next cycle.
- An email failure is logged but never crashes the process or stops monitoring.
- `SIGINT`/`SIGTERM` (sent by PM2 or systemd on restart/stop) trigger a graceful shutdown: the current cycle finishes, state is saved, and the process exits cleanly.

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local `.env` file:

```bash
cp .env.example .env
```

Edit `.env` — see the comments in `.env.example` for what each variable does. At minimum you'll need SMTP credentials and at least one recipient in `EMAIL_TO`.

Run the continuous monitor locally:

```bash
npm start
```

Or run a single one-off check (useful for quick testing, same behaviour as before):

```bash
npm run check
```

Stop the monitor with `Ctrl+C` — it will shut down gracefully.

---

## Deploying to a Linux VPS

These steps assume a fresh Ubuntu VPS (22.04/24.04) reachable over SSH.

### 1. Server preparation

```bash
sudo apt update
sudo apt upgrade -y
```

Install Node.js 20 via NodeSource (matches the `engines.node` requirement in `package.json`):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should print v20.x
```

### 2. Get the code

```bash
git clone <your-repository-url>
cd FIXRBot
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
nano .env
```

Fill in:

| Variable | Purpose |
|---|---|
| `EVENT_URL` | FIXR organiser/event page to monitor |
| `EVENT_DATA_URL` | FIXR's Next.js JSON data endpoint for the same event (preferred, checked first) |
| `READER_BASE_URL` | Optional fallback reader proxy used only if FIXR returns `403` |
| `STATE_FILE` | Where to store `state.json` (defaults to `src/state.json`) |
| `EMAIL_TO` | Comma-separated recipient list |
| `EMAIL_FROM` | "From" address for notification emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP credentials for sending email |
| `POLL_INTERVAL_MS` | How often to check FIXR, in milliseconds (default `30000` = 30s) |

**Never commit `.env` or put real credentials in this README** — `.env` is already listed in `.gitignore`.

### 4. Run under PM2

Install PM2 globally:

```bash
sudo npm install -g pm2
```

Start FIXRBot:

```bash
pm2 start src/monitor.js --name fixrbot
```

(This is equivalent to `npm start`, but naming the script directly with PM2 makes restarts and log filtering more predictable.)

Useful PM2 commands:

```bash
pm2 status            # see if fixrbot is running
pm2 logs fixrbot       # tail live logs
pm2 restart fixrbot     # restart after a config or code change
pm2 stop fixrbot         # stop monitoring
```

### 5. Start FIXRBot automatically on reboot

```bash
pm2 startup
```

This prints a command tailored to your OS/user — **copy and run exactly that command** (it typically needs `sudo`, since it installs a system service that starts PM2 at boot). Then save the current process list so PM2 knows to restore `fixrbot` on the next boot:

```bash
pm2 save
```

After this, a VPS reboot will bring the monitor back automatically: `systemd`/init starts PM2 → PM2 restores `fixrbot` → monitoring resumes without any manual steps.

---

## Testing the Deployment

### Test 1 — normal unavailable state
With tickets currently unavailable, run `npm start` (or check `pm2 logs fixrbot`) and confirm each cycle logs `Tickets unavailable`, no email is sent, and the process keeps running.

### Test 2 — tickets become available
Temporarily point `EVENT_DATA_URL`/`EVENT_URL` at a FIXR event that **is** on sale (or edit `src/state.json` to set `"available": false` right before a real event goes live). Confirm exactly one email is sent on the transition and `state.json` updates to `"available": true`.

### Test 3 — tickets remain available
With `state.json` already `"available": true` and the event still on sale, confirm subsequent cycles log the check but send **no additional email**.

### Test 4 — FIXR temporarily fails
Simulate a failure (e.g. temporarily set `EVENT_DATA_URL` to an invalid URL, or block outbound network briefly). Confirm the log shows `[ERROR] FIXR request failed: ...`, `state.json`'s `available` field is unchanged, and the process keeps retrying on the next interval rather than crashing.

### Test 5 — email fails
Temporarily set an incorrect `SMTP_PASS`, then force an `available: false -> true` transition. Confirm the log shows an email failure but the process keeps running and does not exit.

### Test 6 — VPS reboot
```bash
sudo reboot
```
After the VPS comes back up, run `pm2 status` — `fixrbot` should show as `online` without you having to start it manually.

---

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

If sending the email fails, this is logged (`[ERROR] Email failed: ...`) but does not stop monitoring, and does not prevent `state.json` from recording the current availability — since the transition check is edge-triggered on `state.json`, no email will be resent purely because of the earlier failure while tickets remain available. If you need a guaranteed retry of the notification itself, check the logs for `Email failed` and re-run manually, or reduce `POLL_INTERVAL_MS` around expected on-sale times.

## Alternative: GitHub Actions (manual testing only)

`.github/workflows/monitor.yml` no longer runs on a schedule. It's kept only as an optional, manually-triggered ("Run workflow" in the Actions tab) way to run a single check from CI — useful for testing changes without touching the VPS. **Do not re-enable a `schedule:` trigger on this workflow** while the VPS is also running `monitor.js`, or FIXR will be polled from two places at once and you may receive duplicate or conflicting state.

If you use the manual workflow, set these repository secrets (**Settings → Secrets and variables → Actions → Secrets**): `EMAIL_TO`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and optionally these repository variables: `EVENT_URL`, `EVENT_DATA_URL`, `READER_BASE_URL`.

## Notes & Limitations

- **FIXR page/endpoint changes**: FIXR may change its page structure or redeploy with a new Next.js build ID. If detection stops working, open the organiser page source, find `__NEXT_DATA__.buildId`, and update `EVENT_DATA_URL` to `https://fixr.co/_next/data/<buildId>/organiser/timepiece.json`.
- **HTTP 403 / rate limiting**: FIXR may block automated requests, especially from shared/cloud IP ranges. The monitor tries `READER_BASE_URL` as a fallback, but this is not guaranteed to always work, and overly frequent polling increases the chance of being blocked.
- **Network failures**: DNS issues, timeouts, or FIXR outages will pause detection for that cycle only — the monitor retries on the next interval rather than assuming tickets are unavailable.
- **Polling frequency vs. load**: `POLL_INTERVAL_MS` is a trade-off between how quickly you find out tickets are live and how much load/risk of being rate-limited you accept. 30–60 seconds is a reasonable default; very short intervals (under 5s, which the monitor enforces as a floor) are actively discouraged.
- **Email delivery delay**: delivery time depends on your SMTP provider and is outside this application's control — for time-sensitive on-sales, test your SMTP setup's typical latency in advance.
- Credentials are read only from environment variables (`.env` locally, or actual environment variables / PM2 ecosystem config on the VPS) and are never logged or written to `state.json`.




hqon yqby hegl wqny