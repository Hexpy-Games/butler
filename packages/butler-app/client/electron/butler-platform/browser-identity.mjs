// Chromium's reduced User-Agent: the frozen OS token Chrome reports on each
// platform, whatever the real OS version or CPU, and only the major version.
const PLATFORM_TOKENS = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
  linux: "X11; Linux x86_64",
};

const major = (version) => version.split(".")[0];

/** The identity web content sees: Chromium's reduced UA plus an honest
 * `Butler/<major>` product token. No Electron token, no prerelease suffix. */
export function webUserAgent(chromeVersion, appVersion, platform = process.platform) {
  const token = PLATFORM_TOKENS[platform] ?? PLATFORM_TOKENS.linux;
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major(chromeVersion)}.0.0.0 Safari/537.36 Butler/${major(appVersion)}`;
}
