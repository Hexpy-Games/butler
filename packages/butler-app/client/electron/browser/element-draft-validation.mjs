/** Only uploaded file references, never crop blobs in the bounded composer cache. */
export function validElements(items) {
  return Array.isArray(items) && items.every(item => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.site === "string" && [item.file, item.crop].every(file => file && typeof file.file_id === "string" && typeof file.url === "string" && typeof file.safe_name === "string"));
}
