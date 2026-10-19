/** Preview tags publish to the preview update channel; signing is the same for every release. */
export function isPreviewRelease(): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+-preview\..+$/u.test(process.env.GITHUB_REF_NAME ?? "");
}
