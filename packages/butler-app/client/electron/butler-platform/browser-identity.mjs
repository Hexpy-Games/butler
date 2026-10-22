// Chromium's reduced User-Agent: the frozen OS token Chrome reports on each
// platform, whatever the real OS version or CPU, and only the major version.
const PLATFORM_TOKENS = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
  linux: "X11; Linux x86_64",
};

/** The plain Chromium identity web content sees: no Electron or App token. */
export function plainChromiumUserAgent(chromeVersion, platform = process.platform) {
  const token = PLATFORM_TOKENS[platform] ?? PLATFORM_TOKENS.linux;
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion.split(".")[0]}.0.0.0 Safari/537.36`;
}
