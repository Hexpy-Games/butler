import { describe, expect, test } from "bun:test";
import {
  discoverPackagedProcessTargets,
  hasCompleteProcessAttribution,
  REQUIRED_PACKAGED_PROCESS_LABELS,
} from "./packaged-memory-processes.ts";

describe("packaged memory process discovery contract", () => {
  test("exports a discovery boundary that requires the isolated launch and data roots", () => {
    expect(typeof discoverPackagedProcessTargets).toBe("function");
    expect(discoverPackagedProcessTargets.length).toBe(2);
  });

  test("requires one stable label per real process instance", () => {
    const complete = REQUIRED_PACKAGED_PROCESS_LABELS.map((label, index) => ({
      role: index < 4 ? "electron_utility" as const : "owned_sidecar" as const,
      pid: index + 1,
      label,
    }));
    expect(hasCompleteProcessAttribution(complete)).toBe(true);
    expect(hasCompleteProcessAttribution(complete.slice(0, -1))).toBe(false);
    expect(hasCompleteProcessAttribution([...complete.slice(0, -1), { ...complete[0]!, pid: 99 }])).toBe(false);
  });
});
