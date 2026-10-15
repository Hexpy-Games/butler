/** Provider authentication uses the user's default browser and existing sessions. */
export function openExternalSignIn(url: string): void {
  if (window.butlerBrowser) void window.butlerBrowser.call("open-external-signin", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}
