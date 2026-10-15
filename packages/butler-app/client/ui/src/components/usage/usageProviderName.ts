/** Readable fallback for provider IDs absent from the model catalog. */
export function usageProviderName(id: string): string {
  return id.split(/[-_\s]+/u).filter(Boolean).map(word => word.charAt(0).toLocaleUpperCase() + word.slice(1)).join(" ");
}
