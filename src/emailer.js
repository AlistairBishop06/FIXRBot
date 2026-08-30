const nodemailer = require("nodemailer");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseRecipients(value) {
  return value
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

async function sendTicketAlert({ eventUrl }) {
  const recipients = parseRecipients(requireEnv("EMAIL_TO"));
  if (recipients.length === 0) {
    throw new Error("EMAIL_TO must contain at least one recipient");
  }

  const port = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  const transporter = nodemailer.createTransport({
    host: requireEnv("SMTP_HOST"),
    port,
    secure: port === 465,
    auth: {
      user: requireEnv("SMTP_USER"),
      pass: requireEnv("SMTP_PASS"),
    },
  });

  await transporter.sendMail({
    from: requireEnv("EMAIL_FROM"),
    to: recipients,
    subject: "🎟 Timepiece tickets are live!",
    text: [
      "Good news — tickets for Timepiece are now available on FIXR.",
      "",
      "Grab them here:",
      eventUrl,
      "",
      "Act quickly before they sell out.",
    ].join("\n"),
  });
}

// Alias with the name used by the long-running monitor (src/monitor.js).
// Same function, same behaviour — kept so call sites read clearly as
// "send the availability notification" rather than a generic alert.
const sendAvailabilityEmail = sendTicketAlert;

module.exports = {
  sendTicketAlert,
  sendAvailabilityEmail,
};