/** Only owner-approved preview tags may bypass macOS notarization. */
export function isPreviewRelease(): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+-preview\..+$/u.test(process.env.GITHUB_REF_NAME ?? "");
}
