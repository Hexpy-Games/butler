import type { Page } from "playwright";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { TaskGraphSnapshot } from "../../packages/butler-app/client/shared/task-graph-contracts.ts";
import { HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";

/** The graph fixture seeds records, not executable turn admission/context data.
 * Replay canonical session views for the shell/dialog while graph/document GETs
 * and the selected child session id still travel through the real product paths.
 */
export async function installTaskSessionReplay(page: Page, parent: SessionView, graphs: TaskGraphSnapshot[]) {
  const nodes = graphs.flatMap(g => g.nodes);
  await page.route("**/session-view?**", route => {
    const id = new URL(route.request().url()).searchParams.get("session_id");
    const node = nodes.find(n => n.session_id === id);
    const observer = structuredClone(HARNESS_SS03_OBSERVER_VIEW);
    observer.session_id = id ?? "";
    observer.parent_session_id = parent.session_id;
    observer.relation = { ...observer.relation!, parent_session_id: parent.session_id,
      child_session_id: id ?? "", safe_title: node?.title ?? "Task" };
    observer.messages = [{ ...observer.messages[0]!, chat_id: id ?? "", text: node?.title ?? "Task" }];
    observer.active_turn = null;
    observer.latest_turn = null;
    observer.activity_history = [];
    observer.waiting_for_children = false;
    observer.status = "delivered";
    observer.workers = [];
    return route.fulfill({ json: { protocol_version: "butler.app.v1", data: id === parent.session_id ? parent : observer } });
  });
}
