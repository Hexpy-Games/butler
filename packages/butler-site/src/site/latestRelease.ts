/**
 * Install links download the files of the Latest GitHub release, read once per build.
 * site.yml rebuilds whenever Latest can change.
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

type Release = {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
};

const API_URL = `${REPOSITORY_URL.replace("https://github.com/", "https://api.github.com/repos/")}/releases/latest`;
let latest: Promise<Release> | undefined;

async function fetchLatest(): Promise<Release> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(API_URL, { headers });
  if (!response.ok) throw new Error(`Latest release lookup failed: ${response.status}`);
  return response.json();
}

export async function latestDownload(file: Download, checksum = false): Promise<{ name: string; url: string }> {
  const release = await (latest ??= fetchLatest());
  const version = release.tag_name.replace(/^v/, "");
  const name = DOWNLOADS[file].replace("{version}", version) + (checksum ? ".sha256" : "");
  const asset = release.assets.find((asset) => asset.name === name);
  if (!asset) throw new Error(`Latest release ${release.tag_name} has no ${name}`);
  return { name, url: asset.browser_download_url };
}
