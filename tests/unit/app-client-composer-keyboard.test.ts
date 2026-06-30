import { expect, test } from "bun:test";
import { shouldSubmitComposerEnter } from "../../packages/butler-app/client/ui/src/components/conversation/hooks/useComposerKeyboard.ts";
import { composerControlsForSubmit } from "../../packages/butler-app/client/ui/src/components/conversation/hooks/composerSubmitControls.ts";

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

test("composer submit sends model controls only after an explicit user control change", () => {
  const untouched = composerControlsForSubmit({
    model: "openai/gpt-5.5",
    reasoning: "medium",
    accessMode: "full_access",
    planMode: false,
    controlsTouched: false,
    activeTurn: false,
    attachments: [],
  });
  expect(untouched).toEqual({
    queuePolicy: "send_now",
    attachments: [],
  });

  const touched = composerControlsForSubmit({
    model: "openai/gpt-5.5",
    reasoning: "medium",
    accessMode: "read_only",
    planMode: true,
    controlsTouched: true,
    activeTurn: true,
    attachments: [],
  });
  expect(touched).toMatchObject({
    model: "openai/gpt-5.5",
    reasoningEffort: "medium",
    accessMode: "read_only",
    planMode: true,
    queuePolicy: "enqueue_if_busy",
  });
});
