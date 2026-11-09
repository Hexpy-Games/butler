/**
 * Electron settles `loadURL` inside Chromium's navigation notifications: a page that navigates
 * itself while loading (a script redirect) rejects it from `did-start-navigation`. Stopping,
 * closing or destroying the WebContents there aborts the App, so the outcome arrives on a later task.
 */
export function loadOutsideNavigation(contents, url, options) {
  return new Promise((resolve, reject) => contents.loadURL(url, options).then(
    value => setImmediate(resolve, value), error => setImmediate(reject, error)));
}
