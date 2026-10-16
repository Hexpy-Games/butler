// Native tool probe: a synchronous complete result survives Windows pipe exit.
const fs = require("fs");
const [kind, host, port] = process.argv.slice(2);
function finish(outcome, code = null) {
  fs.writeSync(1, JSON.stringify({ kind, host, port, outcome, code }));
  process.exit(outcome === "connected" ? 0 : 1);
}
process.on("uncaughtException", error => finish("probe-error", error.code || error.message));
setTimeout(() => finish("timeout", "ETIMEDOUT"), 1500);
if (kind === "dns") {
  require("dns").resolve4(host, error => finish(error ? "error" : "connected", error?.code));
} else {
  const socket = require("net").connect(Number(port), host, () => finish("connected"));
  socket.on("error", error => finish("error", error.code));
}
