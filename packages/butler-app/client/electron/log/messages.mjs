const MESSAGES = {
  "app.start": "App started", "app.quit": "App quit", "app.start_failed": "App startup failed",
  "app.version_failed": "App version unavailable", "renderer.crash": "Renderer crashed", "process.crash": "Process crashed",
  "agent.spawn": "Agent started", "agent.exit": "Agent exited", "agent.spawn_failed": "Agent startup failed", "agent.restart": "Agent restart requested",
  "ui.send": "Message sent", "ui.stop": "Response stopped", "ui.model_pick": "Model selected", "ui.retry": "Message retried", "ui.error": "UI error",
  "ipc.payload": "IPC payload recorded", "ipc.completed": "IPC request completed",
  "image.fetch": "Image requested", "snapshot.fetch": "Snapshot resource requested",
  "browser.request": "Browser request started", "browser.completed": "Browser request completed",
  "update.check": "Checking for updates", "update.failed": "Update failed",
  "update.update-available": "Update available", "update.update-not-available": "App is up to date", "update.update-downloaded": "Update downloaded",
};
export function appMessage(event, scope) {
  const message = MESSAGES[event] ?? event.replace(/[._-]+/gu, " ").replace(/^./u, letter => letter.toUpperCase());
  return event === "ui.error" && scope ? `${message} · ${scope}` : message;
}
