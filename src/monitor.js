// src/monitor.js
//
// Long-running monitoring process for 24/7 VPS deployment (e.g. under PM2
// or systemd). Replaces the GitHub Actions schedule: instead of one check
// per workflow run, this process loops forever, waiting POLL_INTERVAL_MS
// between checks and never starting a new FIXR request before the
// previous one has finished.
//
// Availability monitoring only. This file does not implement, and must
// not be extended to implement, automatic ticket purchasing, checkout,
// CAPTCHA bypassing, or account automation.

require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");

const { checkTickets } = require("./checkTickets");
const { sendAvailabilityEmail } = require("./emailer");
const log = require("./logger");

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "state.json");

const DEFAULT_POLL_INTERVAL_MS = 30000;
const MIN_POLL_INTERVAL_MS = 5000; // avoid hammering FIXR even on a bad config

function resolvePollIntervalMs() {
  const raw = process.env.POLL_INTERVAL_MS;
  if (raw === undefined || raw === null || raw.trim() === "") {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    log.warn(
      `Invalid POLL_INTERVAL_MS="${raw}" — falling back to default of ${DEFAULT_POLL_INTERVAL_MS}ms.`
    );
    return DEFAULT_POLL_INTERVAL_MS;
  }

  if (parsed < MIN_POLL_INTERVAL_MS) {
    log.warn(
      `POLL_INTERVAL_MS=${parsed} is below the safety minimum of ${MIN_POLL_INTERVAL_MS}ms — using ${MIN_POLL_INTERVAL_MS}ms instead.`
    );
    return MIN_POLL_INTERVAL_MS;
  }

  return parsed;
}

const POLL_INTERVAL_MS = resolvePollIntervalMs();

function sleep(ms) {
  // Intentionally NOT unref()'d: this timer is what keeps the process
  // alive between checks. Shutdown is handled by checking the
  // `shuttingDown` flag in short slices (see the main loop below), not by
  // letting the event loop go idle.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// --- State persistence -----------------------------------------------
//
// Mirrors the robustness rules from checkTickets.js: a missing or corrupt
// state file should never crash the process, and state must only ever be
// overwritten with a *valid* availability result. A failed FIXR request
// must never be interpreted as "tickets unavailable".

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    if (!raw.trim()) {
      log.warn(`State file at ${STATE_FILE} is empty. Starting from a clean state.`);
      return { available: false, last_checked: null };
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.available !== "boolean") {
      log.warn(`State file at ${STATE_FILE} is malformed. Starting from a clean state.`);
      return { available: false, last_checked: null };
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      log.info(`No existing state file at ${STATE_FILE}. Starting from a clean state.`);
      return { available: false, last_checked: null };
    }
    log.warn(`Could not read state file (${error.message}). Starting from a clean state.`);
    return { available: false, last_checked: null };
  }
}

async function saveState(nextState) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmpFile = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmpFile, `${JSON.stringify(nextState, null, 2)}\n`);
  await fs.rename(tmpFile, STATE_FILE); // atomic on the same filesystem
}

function summarizeSignals(signals) {
  return (signals || [])
    .slice(0, 8)
    .map((signal) => `${signal.type}:${signal.source}=${signal.value}`)
    .join("; ");
}

// --- Graceful shutdown --------------------------------------------------

let shuttingDown = false;
let shutdownRequestedAt = null;

function requestShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownRequestedAt = Date.now();
  log.info(`Received ${signal}. Finishing the current cycle, then shutting down...`);
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

// Never let an unexpected error anywhere in the process kill monitoring
// silently without a log line. These are last-resort safety nets — the
// main loop below already catches errors from each individual cycle.
process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.stack || err.message}`);
});

// --- Main loop ------------------------------------------------------

async function runCycle(previousState) {
  log.info("Checking FIXR...");
  const result = await checkTickets();

  if (!result.ok) {
    // A failed request is NOT the same as "tickets unavailable". Preserve
    // the previous state and only record that an error occurred.
    log.error(`FIXR request failed: ${result.error}`);
    log.info(`Retrying in ${Math.round(POLL_INTERVAL_MS / 1000)} seconds`);
    const preservedState = {
      ...previousState,
      last_checked: result.checkedAt,
      last_error: result.error,
    };
    await saveState(preservedState);
    return preservedState;
  }

  log.info(`Tickets ${result.available ? "available" : "unavailable"}`);
  if (result.availableSignals || result.unavailableSignals) {
    log.info(`Available signals: ${summarizeSignals(result.availableSignals) || "none"}`);
    log.info(`Unavailable signals: ${summarizeSignals(result.unavailableSignals) || "none"}`);
  }

  const becameAvailable = result.available && !previousState.available;

  if (becameAvailable) {
    log.info("Availability changed false -> true. Sending notification email.");
    try {
      await sendAvailabilityEmail({ eventUrl: result.eventUrl });
      log.info("Email sent.");
    } catch (error) {
      // An email failure must not crash monitoring, and must not be
      // treated as if the notification succeeded — but it also must not
      // block us from recording the current availability state, since
      // the FIXR check itself was valid. We keep last_error so it's
      // visible in logs/state, and rely on the *next* cycle's transition
      // check: since state.available will now be true, no duplicate
      // email will be sent while tickets remain available. If the admin
      // wants a retry of the email itself, they can inspect last_error.
      log.error(`Email failed: ${error.message}`);
    }
  }

  const nextState = {
    available: result.available,
    last_checked: result.checkedAt,
    event_url: result.eventUrl,
    last_available_signals: (result.availableSignals || []).slice(0, 8),
    last_unavailable_signals: (result.unavailableSignals || []).slice(0, 8),
    last_error: null,
  };

  await saveState(nextState);
  return nextState;
}

async function main() {
  log.info("FIXRBot monitor starting up.");
  log.info(`Polling interval: ${POLL_INTERVAL_MS}ms (${Math.round(POLL_INTERVAL_MS / 1000)}s)`);

  let state = await loadState();
  log.info(`Loaded previous availability: ${Boolean(state.available)}`);

  while (!shuttingDown) {
    try {
      state = await runCycle(state);
    } catch (error) {
      // Defensive catch-all: runCycle already handles FIXR and email
      // failures internally, but any other unexpected error (e.g. a disk
      // write failure) must still not stop the loop.
      log.error(`Unexpected error during monitoring cycle: ${error.stack || error.message}`);
    }

    if (shuttingDown) break;

    // Sleep in short slices so a shutdown signal received mid-wait takes
    // effect promptly instead of waiting out the full interval.
    const sliceMs = 1000;
    let waited = 0;
    while (waited < POLL_INTERVAL_MS && !shuttingDown) {
      const step = Math.min(sliceMs, POLL_INTERVAL_MS - waited);
      await sleep(step);
      waited += step;
    }
  }

  const downtimeMs = shutdownRequestedAt ? Date.now() - shutdownRequestedAt : 0;
  log.info(`Shutdown complete after ${downtimeMs}ms of cleanup. Goodbye.`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { runCycle, resolvePollIntervalMs };