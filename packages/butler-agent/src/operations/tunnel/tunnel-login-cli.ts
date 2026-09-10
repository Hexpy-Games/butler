import { issueTunnelLoginLink } from "./tunnel-http-proxy.ts";

const [directory, origin] = process.argv.slice(2);
if (!directory || !origin) throw new Error("Usage: tunnel-login-cli.ts <login-directory> <https-origin>");
// Explicit operator command: output is sensitive and must not enter shared logs.
process.stdout.write(`${JSON.stringify(issueTunnelLoginLink(directory, origin))}\n`);
