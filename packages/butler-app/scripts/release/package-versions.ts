/** Package metadata has platform-specific ordering; release identities stay exact. */
function parts(version: string): { base: string; prerelease?: string } {
  const match = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) throw new Error(`Invalid package version: ${version}`);
  return { base: match[1]!, prerelease: match[2] };
}

export function archPackageVersion(version: string): string {
  const { base, prerelease } = parts(version);
  // vercmp: 1.0pre < 1.0 < 1.0.pre. Do not insert a separator before the suffix.
  if (!prerelease) return base;
  const suffix = prerelease.replaceAll("-", "_");
  return `${base}${/^[A-Za-z]/u.test(suffix) ? suffix : `pre${suffix}`}`;
}

export function debPackageVersion(version: string): string {
  const { base, prerelease } = parts(version);
  return prerelease ? `${base}~${prerelease}` : base;
}
