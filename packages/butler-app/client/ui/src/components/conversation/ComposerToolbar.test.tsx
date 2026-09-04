/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore";
import { ComposerToolbar } from "./ComposerToolbar";

test("composer toolbar keeps stable left and right control groups", () => {
  const before = useComposerStore.getState();
  useComposerStore.setState({ planMode: true });
  const html = renderToStaticMarkup(<ComposerToolbar />);
  useComposerStore.setState(before);

  const plus = html.indexOf('data-test-class="attachment-button"');
  const access = html.indexOf('data-test-class="access-button"');
  const spacer = html.indexOf('data-test-class="composer-toolbar-spacer"');
  const context = html.indexOf('data-test-class="context-donut-button"');
  const model = html.indexOf('data-test-class="model-button"');
  const send = html.indexOf('data-test-class="composer-send-button"');

  expect(plus).toBeGreaterThanOrEqual(0);
  expect(access).toBeGreaterThanOrEqual(0);
  expect(spacer).toBeGreaterThanOrEqual(0);
  expect(context).toBeGreaterThanOrEqual(0);
  expect(model).toBeGreaterThanOrEqual(0);
  expect(send).toBeGreaterThanOrEqual(0);
  expect(plus).toBeLessThan(access);
  expect(access).toBeLessThan(spacer);
  expect(spacer).toBeLessThan(context);
  expect(context).toBeLessThan(model);
  expect(model).toBeLessThan(send);
  expect(html).not.toContain(
    appCopy.settings.options.modifierEnterSendEnterNewline,
  );
  expect(html).not.toContain(
    appCopy.settings.options.enterSendShiftEnterNewline,
  );
});

test("Plan decisions reuse the composer toolbar instead of a second input form", () => {
  const html = renderToStaticMarkup(
    <ComposerToolbar
      planDecision={{
        canSubmitInstruction: true,
        instructionPlaceholder: "Revise the Plan",
        pending: false,
        onAccept: () => undefined,
        onReject: () => undefined,
        onSubmitInstruction: () => undefined,
      }}
    />,
  );

  expect(html).toContain('data-test-class="composer-plan-decision-actions"');
  expect(html).toContain(appCopy.composer.planAccept);
  expect(html).toContain(appCopy.composer.planReject);
  expect(html).not.toContain("plan-decision-form");
  expect(html).not.toContain("<input");
});
