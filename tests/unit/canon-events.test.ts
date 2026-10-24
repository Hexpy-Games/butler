// test-category: pure-logic
import { expect, test } from "bun:test";
import { publishCanonEvent, subscribeCanonChanges } from "../../packages/butler-app/client/ui/src/app/canonEvents.ts";
import type { TimelineEvent } from "../../packages/butler-app/client/ui/src/app/types.ts";

test("canon and space changes target one project; unscoped space changes target sidebars only", () => {
  const received: string[] = [];
  const subscriptions = [
    subscribeCanonChanges(() => { received.push("sidebar-a"); }, { projectId: "a", sidebar: true }),
    subscribeCanonChanges(() => { received.push("board-a"); }, { projectId: "a" }),
    subscribeCanonChanges(() => { received.push("active-b"); }, { projectId: "b" }),
    subscribeCanonChanges(() => { received.push("sidebar-b"); }, { projectId: "b", sidebar: true }),
  ];
  const publish = (type: string, payload = {}) => publishCanonEvent({ type, payload } as TimelineEvent);
  try {
    for (const type of ["canon.changed", "canon.progress_changed", "space.changed"]) {
      publish(type, { project_id: "a" });
      expect(received.splice(0)).toEqual(["sidebar-a", "board-a"]);
      publish(type, { project_id: "b" });
      expect(received.splice(0)).toEqual(["active-b", "sidebar-b"]);
    }
    publish("space.changed");
    expect(received.splice(0)).toEqual(["sidebar-a", "sidebar-b"]);
    publish("canon.changed");
    publish("unrelated.changed");
    expect(received).toEqual([]);
    publish("stream.reconcile_required");
    expect(received.splice(0)).toEqual(["sidebar-a", "board-a", "active-b", "sidebar-b"]);
    publish("work_model.changed", { scope: "tasks" });
    expect(received).toEqual([]);
  } finally { subscriptions.forEach(unsubscribe => unsubscribe()); }
  publish("space.changed");
  expect(received).toEqual([]);
});
