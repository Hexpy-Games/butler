const numberFormatter = new Intl.NumberFormat(undefined);

export function formatCount(value: number): string {
  return numberFormatter.format(value);
}
