import { session } from "electron";

let isolated;

/** Browser presenters use DIP geometry and must not share the App origin's zoom. */
export function overlaySession() {
  if (!isolated) {
    isolated = session.fromPartition("butler-browser-overlay");
    isolated.protocol.handle("app", request => session.defaultSession.fetch(request.url));
  }
  return isolated;
}
