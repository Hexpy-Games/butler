import { watchAppUserWork } from "../app-user-work-events.mjs";

/** Logging remains subscribed even when no window or pending update exists. */
export function watchAppLogging({ connect, refresh }) {
  let previous;
  return watchAppUserWork({ connect, onConnected: () => { void refresh(); },
    onEvent(event) {
      if (["logs.cleared", "stream.reconcile_required"].includes(event.type)) void refresh();
      if (event.type !== "settings.updated") return;
      const settings = event.payload?.settings;
      if (!settings) return;
      const current = JSON.stringify([settings.log_level, settings.log_category_levels, settings.diagnostics_enabled]);
      if (current !== previous) { previous = current; void refresh(); }
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
