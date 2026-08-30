// Minimal timestamped logger. No external dependencies.
//
// NEVER pass secrets (SMTP passwords, API keys, tokens, .env contents) to
// these functions — callers are responsible for keeping log lines free of
// credentials.

function timestamp() {
  // "YYYY-MM-DD HH:MM:SS" in local server time.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

function info(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function warn(message) {
  console.warn(`[${timestamp()}] [WARN] ${message}`);
}

function error(message) {
  console.error(`[${timestamp()}] [ERROR] ${message}`);
}

module.exports = { info, warn, error };