// test-category: pure-logic
import { expect, test } from "bun:test";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import { localizeWorkerActivity } from "./workerActivityLocalization";
import { toolchainGroupLabel } from "./toolchainUtils";

test("legacy Worker statuses and invocation summaries follow the interface locale", () => {
  const previous = getAppLocale();
  try {
    setAppCopyLanguage("en-US");
    expect(localizeWorkerActivity("실패")).toBe("Failed");
    expect(localizeWorkerActivity("작업 중")).toBe("Working");
    expect(localizeWorkerActivity("읽기: routes.ts")).toBe("읽기: routes.ts");
    for (const [tool, label] of [["wait_for_worker", "Wait for worker"], ["delegate_to_worker", "Delegated work"]]) {
      expect(toolchainGroupLabel({ id: tool!, kind: "used_tool", state: "delivered", bridge_phase: "btcc_operation", safe_tool_name: tool!, safe_label: "작업 위임" })).toBe(label!);
    }
    setAppCopyLanguage("ko-KR");
    expect(localizeWorkerActivity("Failed")).toBe("실패");
    expect(localizeWorkerActivity("Review routes.ts")).toBe("Review routes.ts");
  } finally {
    setAppCopyLanguage(previous);
  }
});
