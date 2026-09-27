/** Joins class names, skipping empty values. DS-internal: product code never passes classes. */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
