export function parseScalar(value) {
  const raw = value.trim();
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  const trimmed = raw.replace(/^'|'$/g, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const frontmatter = text.slice(4, end).trim();
  const data = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = parseScalar(match[2] ?? "");
  }
  return data;
}

export function frontmatterBody(text) {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\n/u, "");
}

export function formatScalar(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

export function formatFrontmatter(data) {
  return Object.entries(data)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${formatScalar(value)}`)
    .join("\n");
}

export function markdownWithFrontmatter(data, body) {
  return `---\n${formatFrontmatter(data)}\n---\n\n${body.trim()}\n`;
}
