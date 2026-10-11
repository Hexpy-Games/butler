/** Protocol handlers may return bundle names or executable basenames. */
export function normalizeBrowserName(value) {
  const name = value.trim().replace(/\.(?:app|exe)$/iu, "");
  return { chrome: "Google Chrome", msedge: "Microsoft Edge", safari: "Safari" }[name.toLowerCase()] ?? name;
}
