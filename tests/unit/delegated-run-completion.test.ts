// test-category: pure-logic
import { expect, test } from "bun:test";
import { delegatedRunComplete } from "../support/delegated-run-completion";

const receipt = { relation_id: "relation", status: "delivered", turn_id: "result-turn" };
const final = { role: "assistant", status: "delivered", turn_id: "result-turn", text: "Result" };
const view = {
  latest_turn: { state: "delivered" }, active_turn: null,
  steward_children: [{ terminal: true, result: { summary: "Result" }, relation: { relation_id: "relation" } }],
  messages: [final],
};

test("waits for child result, result receipt and its parent final answer", () => {
  expect(delegatedRunComplete(view, [receipt])).toBe(true);
  expect(delegatedRunComplete({ ...view, steward_children: [] }, [])).toBe(false);
  expect(delegatedRunComplete({ ...view, steward_children: [{ ...view.steward_children[0], terminal: false }] }, [receipt])).toBe(false);
  expect(delegatedRunComplete({ ...view, steward_children: [{ ...view.steward_children[0], result: null }] }, [receipt])).toBe(false);
  expect(delegatedRunComplete(view, [{ ...receipt, status: "pending" }])).toBe(false);
  expect(delegatedRunComplete(view, [{ ...receipt, relation_id: "other" }])).toBe(false);
  expect(delegatedRunComplete(view, [{ ...receipt, turn_id: null }])).toBe(false);
  expect(delegatedRunComplete({ ...view, messages: [{ ...final, turn_id: "ack-turn" }] }, [receipt])).toBe(false);
  expect(delegatedRunComplete({ ...view, messages: [{ ...final, status: "streaming" }] }, [receipt])).toBe(false);
  expect(delegatedRunComplete({ ...view, messages: [{ ...final, text: " " }] }, [receipt])).toBe(false);
  expect(delegatedRunComplete({ ...view, messages: [{ ...final, text: "", answer_blocks: [{ type: "text", text: "Result" }] }] }, [receipt])).toBe(true);
  expect(delegatedRunComplete({ ...view, active_turn: { state: "thinking" } }, [receipt])).toBe(false);
});
