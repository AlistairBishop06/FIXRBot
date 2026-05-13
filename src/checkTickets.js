require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const axios = require("axios");
const cheerio = require("cheerio");
const { sendTicketAlert } = require("./emailer");

const EVENT_URL = process.env.EVENT_URL || "https://fixr.co/organiser/timepiece";
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "state.json");

const AVAILABLE_TEXT = [
  "buy tickets",
  "get tickets",
  "select tickets",
  "book tickets",
  "book now",
  "purchase tickets",
  "tickets available",
  "available now",
  "checkout",
];

const UNAVAILABLE_TEXT = [
  "sold out",
  "currently unavailable",
  "no tickets available",
  "tickets unavailable",
  "sales ended",
  "sale ended",
  "tickets are not available",
  "join waiting list",
  "join waitlist",
];

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function makeSignal(type, source, value) {
  return { type, source, value };
}

function walkJson(value, visitor, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, visitor, seen));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    visitor(key, child);
    walkJson(child, visitor, seen);
  }
}

function collectJsonSignals($) {
  const signals = [];

  $("script").each((_, element) => {
    const raw = $(element).contents().text().trim();
    if (!raw || (!raw.startsWith("{") && !raw.startsWith("["))) return;

    try {
      const parsed = JSON.parse(raw);
      walkJson(parsed, (key, value) => {
        const normalizedKey = normalizeText(key);
        const normalizedValue = normalizeText(value);

        if (typeof value === "string") {
          if (
            normalizedKey.includes("availability") &&
            /instock|in stock|available|limitedavailability/.test(normalizedValue)
          ) {
            signals.push(makeSignal("available", `json:${key}`, value));
          }

          if (
            normalizedKey.includes("availability") &&
            /soldout|sold out|outofstock|out of stock|unavailable/.test(normalizedValue)
          ) {
            signals.push(makeSignal("unavailable", `json:${key}`, value));
          }

          if (
            /status|sale|state/.test(normalizedKey) &&
            /live|open|available|on sale|onsale/.test(normalizedValue)
          ) {
            signals.push(makeSignal("available", `json:${key}`, value));
          }
        }

        if (typeof value === "boolean") {
          if (/soldout|sold_out|is_sold_out|isSoldOut/i.test(key)) {
            signals.push(makeSignal(value ? "unavailable" : "available", `json:${key}`, value));
          }

          if (/available|onSale|on_sale|is_live|isLive/i.test(key) && value === true) {
            signals.push(makeSignal("available", `json:${key}`, value));
          }
        }

        if (
          typeof value === "number" &&
          /remaining|quantity|inventory|available_count|availableCount/i.test(key) &&
          value > 0
        ) {
          signals.push(makeSignal("available", `json:${key}`, value));
        }
      });
    } catch {
      // Ignore non-JSON script tags.
    }
  });

  return signals;
}

function collectHtmlSignals($) {
  const signals = [];
  const bodyText = normalizeText($("body").text());

  for (const phrase of AVAILABLE_TEXT) {
    if (bodyText.includes(phrase)) {
      signals.push(makeSignal("available", "html", phrase));
    }
  }

  for (const phrase of UNAVAILABLE_TEXT) {
    if (bodyText.includes(phrase)) {
      signals.push(makeSignal("unavailable", "html", phrase));
    }
  }

  $("a, button").each((_, element) => {
    const label = normalizeText($(element).text());
    const disabled =
      $(element).attr("disabled") !== undefined ||
      $(element).attr("aria-disabled") === "true" ||
      /disabled|sold-out|soldout/.test($(element).attr("class") || "");

    if (!label || disabled) return;

    if (AVAILABLE_TEXT.some((phrase) => label.includes(phrase))) {
      signals.push(makeSignal("available", "action", label));
    }
  });

  const eventLinks = new Set();
  $("a[href*='/event/']").each((_, element) => {
    const href = $(element).attr("href");
    if (href && !href.includes("/event/timepiece")) {
      eventLinks.add(href.split("?")[0]);
    }
  });

  if (eventLinks.size > 0) {
    signals.push(makeSignal("available", "event-listings", `${eventLinks.size} event link(s)`));
  }

  return signals;
}

function decideAvailability(signals) {
  const availableSignals = signals.filter((signal) => signal.type === "available");
  const unavailableSignals = signals.filter((signal) => signal.type === "unavailable");

  return {
    available: availableSignals.length > 0,
    availableSignals,
    unavailableSignals,
  };
}

async function fetchEventHtml(eventUrl) {
  const response = await axios.get(eventUrl, {
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FIXR-Timepiece-Monitor/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
      "Cache-Control": "no-cache",
    },
  });

  const html = String(response.data || "");
  if (/just a moment|cf-mitigated|enable javascript and cookies/i.test(html)) {
    throw new Error("FIXR returned an anti-bot challenge page");
  }

  return response.data;
}

async function checkTicketAvailability(eventUrl = EVENT_URL) {
  const html = await fetchEventHtml(eventUrl);
  const $ = cheerio.load(html);
  const signals = [...collectJsonSignals($), ...collectHtmlSignals($)];
  const decision = decideAvailability(signals);

  return {
    eventUrl,
    checkedAt: new Date().toISOString(),
    ...decision,
  };
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { available: false, last_checked: null };
    }
    throw error;
  }
}

async function saveState(nextState) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(`${STATE_FILE}.tmp`, `${JSON.stringify(nextState, null, 2)}\n`);
  await fs.rename(`${STATE_FILE}.tmp`, STATE_FILE);
}

function summarizeSignals(signals) {
  return signals
    .slice(0, 8)
    .map((signal) => `${signal.type}:${signal.source}=${signal.value}`)
    .join("; ");
}

async function main() {
  const previousState = await loadState();
  console.log(`Checking Timepiece tickets: ${EVENT_URL}`);
  console.log(`Previous availability: ${Boolean(previousState.available)}`);

  let result;
  try {
    result = await checkTicketAvailability(EVENT_URL);
  } catch (error) {
    const checkedAt = new Date().toISOString();
    await saveState({
      ...previousState,
      last_checked: checkedAt,
      last_error: error.message,
    });
    console.error(`Ticket check failed at ${checkedAt}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Current availability: ${result.available}`);
  console.log(`Available signals: ${summarizeSignals(result.availableSignals) || "none"}`);
  console.log(`Unavailable signals: ${summarizeSignals(result.unavailableSignals) || "none"}`);

  const becameAvailable = result.available && !previousState.available;

  if (becameAvailable) {
    console.log("Tickets appear to be newly available. Sending alert email.");
    try {
      await sendTicketAlert({ eventUrl: result.eventUrl });
      console.log("Alert email sent.");
    } catch (error) {
      await saveState({
        ...previousState,
        last_checked: result.checkedAt,
        last_error: `Email failed: ${error.message}`,
      });
      console.error(`Email failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("No new alert needed.");
  }

  await saveState({
    available: result.available,
    last_checked: result.checkedAt,
    event_url: result.eventUrl,
    last_available_signals: result.availableSignals.slice(0, 8),
    last_unavailable_signals: result.unavailableSignals.slice(0, 8),
    last_error: null,
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  checkTicketAvailability,
};
