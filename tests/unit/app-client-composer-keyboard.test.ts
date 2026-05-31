import { expect, test } from "bun:test";
import { shouldSubmitComposerEnter } from "../../packages/butler-app/client/ui/src/components/conversation/hooks/useComposerKeyboard.ts";

test("composer Enter shortcut sends only in Enter-send mode", () => {
  expect(
    shouldSubmitComposerEnter({
      multilineSendBehavior: "enter_send_shift_enter_newline",
    }),
  ).toBe(true);
  expect(
    shouldSubmitComposerEnter({
      multilineSendBehavior: "enter_send_shift_enter_newline",
      shiftKey: true,
    }),
  ).toBe(false);
});

test("composer modifier shortcut keeps plain Enter for newlines", () => {
  expect(
    shouldSubmitComposerEnter({
      multilineSendBehavior: "modifier_enter_send_enter_newline",
    }),
  ).toBe(false);
  expect(
    shouldSubmitComposerEnter({
      multilineSendBehavior: "modifier_enter_send_enter_newline",
      metaKey: true,
    }),
  ).toBe(true);
  expect(
    shouldSubmitComposerEnter({
      multilineSendBehavior: "modifier_enter_send_enter_newline",
      ctrlKey: true,
    }),
  ).toBe(true);
});
