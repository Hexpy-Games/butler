// test-category: pure-logic
import { expect, test } from "bun:test";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import { toolchainGroupLabel } from "./toolchainUtils";

test("tool invocation summaries follow the interface locale", () => {
  const previous = getAppLocale();
  try {
    setAppCopyLanguage("en-US");
    for (const [tool, label] of [["wait_for_worker", "Wait for worker"], ["delegate_to_worker", "Delegated work"]]) {
      expect(toolchainGroupLabel({ id: tool!, kind: "used_tool", state: "delivered", bridge_phase: "btcc_operation", safe_tool_name: tool!, safe_label: "작업 위임" })).toBe(label!);
    }
  } finally {
    setAppCopyLanguage(previous);
  }
});
