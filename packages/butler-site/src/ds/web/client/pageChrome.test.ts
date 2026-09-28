import { describe, expect, test } from "bun:test";
import { controlKeyLabel } from "./pageChrome";

describe("controlKeyLabel", () => {
  test("keeps the rest of the combination when Command becomes Control", () => {
    expect(controlKeyLabel("Command K", ["⌘", "K"])).toBe("Control K");
    expect(controlKeyLabel("Command Enter", ["⌘", "Enter"])).toBe("Control Enter");
    expect(controlKeyLabel("Command Shift K", ["⌘", "Shift", "K"])).toBe("Control Shift K");
  });

  test("speaks the key caps when the shortcut has no label", () => {
    expect(controlKeyLabel(null, ["⌘", "Enter"])).toBe("Control Enter");
    expect(controlKeyLabel("", ["⌘", "K"])).toBe("Control K");
  });
});
