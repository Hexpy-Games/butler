export function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
