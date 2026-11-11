/**
 * Install links download the newest published release that has the file, read once per build.
 * The newest release normally has every file; when one is missing (a failed upload), only
 * that link falls back to the newest release that has it, and its file name shows that version.
 * site.yml rebuilds whenever a release is published.
 */
import { REPOSITORY_URL } from "./meta";

const DOWNLOADS = {
  macos: "butler-app-{version}-darwin-arm64.dmg",
  windows: "ButlerSetup-{version}-x64.exe",
  "deb-x64": "butler-app-{version}-linux-x64.deb",
  "deb-arm64": "butler-app-{version}-linux-arm64.deb",
  "arch-x64": "butler-app-{version}-archlinux-x64.pkg.tar.zst",
} as const;

export type Download = keyof typeof DOWNLOADS;

export type Release = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string; browser_download_url: string }[];
};

const API_URL = `${REPOSITORY_URL.replace("https://github.com/", "https://api.github.com/repos/")}/releases?per_page=100`;
let releases: Promise<Release[]> | undefined;

async function fetchReleases(): Promise<Release[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(API_URL, { headers });
  if (!response.ok) throw new Error(`Release lookup failed: ${response.status}`);
  return response.json();
}

/** The newest published release (not a draft or prerelease) that has `file`; a checksum comes from that same release. */
export function pickDownload(all: Release[], file: Download, checksum = false): { name: string; url: string } {
  const published = all
    .filter((release) => !release.draft && !release.prerelease)
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  for (const release of published) {
    const base = DOWNLOADS[file].replace("{version}", release.tag_name.replace(/^v/, ""));
    if (!release.assets.some((asset) => asset.name === base)) continue;
    const name = base + (checksum ? ".sha256" : "");
    const asset = release.assets.find((candidate) => candidate.name === name);
    if (!asset) throw new Error(`Release ${release.tag_name} has ${base} but no ${name}`);
    return { name, url: asset.browser_download_url };
  }
  throw new Error(`No published release has ${DOWNLOADS[file]}`);
}

export async function latestDownload(file: Download, checksum = false): Promise<{ name: string; url: string }> {
  return pickDownload(await (releases ??= fetchReleases()), file, checksum);
}
