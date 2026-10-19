import { watchAppUserWork } from "../app-user-work-events.mjs";

/** Logging remains subscribed even when no window or pending update exists. */
export function watchAppLogging({ connect, refresh }) {
  return watchAppUserWork({ connect, onConnected: () => { void refresh(); },
    onEvent(event) {
      if (["logs.cleared", "stream.reconcile_required"].includes(event.type)) void refresh();
      if (event.type !== "settings.updated") return;
      const settings = event.payload?.settings;
      if (!settings) return;
      if (["log_level", "log_category_levels", "diagnostics_enabled"].some(key => Object.hasOwn(settings, key))) void refresh();
    },
  });
}

/** A disconnected or slow agent must not hold the first window hostage. */
export async function refreshBeforeWindow(logging, ready) {
  if (!ready) return;
  let timer;
  try {
    await Promise.race([logging.refresh(), new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
  } finally { clearTimeout(timer); }
}
