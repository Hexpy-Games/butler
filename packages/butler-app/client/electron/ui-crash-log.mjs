// Crash diagnostics accept no arbitrary prose, URLs, payloads or private paths.
export const CRASH_LOG_LIMIT = 50;
export const CRASH_LOG_BYTES = 256 * 1024;
export const CRASH_LOG_KEY = "butler.ui-crashes.v1";
const PAGES = new Set(["app", "session", "settings", "automations", "automation-detail", "project-dashboard"]);
const SCOPES = new Set(["app", "onboarding", "legacy-recovery", "settings", "schedules", "project-dashboard",
  "conversation", "messages", "composer", "inspector", "inspector-summary", "inspector-context",
  "inspector-artifacts", "inspector-automations", "inspector-workers", "window-error", "unhandled-rejection"]);

function safeMessage(value) {
  const message = typeof value === "string" ? value.slice(0, 2048) : "";
  const native = message.match(/^(?:TypeError: )?(Cannot read properties of (?:undefined|null)|Cannot set properties of (?:undefined|null)|undefined is not an object|null is not an object)/u);
  if (native) return native[1];
  if (/Maximum update depth exceeded/u.test(message)) return "Maximum update depth exceeded";
  if (/Rendered (?:more|fewer) hooks/u.test(message)) return "Hook order changed";
  const name = message.match(/^(TypeError|ReferenceError|RangeError|SyntaxError|Error)\b/u)?.[1] ?? "Error";
  return `${name}: [redacted]`;
}

function safeFrames(value) {
  if (typeof value !== "string") return "";
  // Keep bundle coordinates and component names; omit the error's first line.
  return value.slice(0, 32_768).split("\n").flatMap((line) => {
    if (!/^\s*(?:at |[A-Za-z_$][\w$]*@)/u.test(line)) return [];
    const name = line.match(/^\s*at ([A-Za-z_$][\w$]{0,79})(?:\s|\s*\()/u)?.[1];
    const location = line.match(/(?:\/|\b)([A-Za-z0-9_-]+\.(?:js|tsx?|mjs)):(\d+):(\d+)/u);
    if (location) return [`    at ${name ?? "<frame>"} (${location[1]}:${location[2]}:${location[3]})`];
    const anonymous = line.match(/:(\d+):(\d+)\)?$/u);
    if (anonymous) return [`    at ${name ?? "<frame>"} (<script>:${anonymous[1]}:${anonymous[2]})`];
    return name ? [`    at ${name}`] : [];
  }).slice(0, 30).join("\n");
}

export function normalizeCrash(input, version) {
  const page = PAGES.has(input?.page) ? input.page : "app";
  const scope = SCOPES.has(input?.scope) ? input.scope : "app";
  const appVersion = version ?? input?.appVersion;
  return {
    message: safeMessage(input?.message),
    stack: safeFrames(input?.stack),
    componentStack: safeFrames(input?.componentStack),
    page, scope,
    appVersion: typeof appVersion === "string" && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(appVersion) ? appVersion : "unknown",
    timestamp: typeof input?.timestamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.timestamp)
      && Number.isFinite(Date.parse(input.timestamp)) ? input.timestamp : new Date().toISOString(),
  };
}

export function appendCrash(entries, input, version) {
  const next = [...entries.slice(-(CRASH_LOG_LIMIT - 1)), normalizeCrash(input, version)];
  while (new TextEncoder().encode(JSON.stringify(next)).length >= CRASH_LOG_BYTES) next.shift();
  return next;
}
