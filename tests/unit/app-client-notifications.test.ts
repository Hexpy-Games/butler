// test-category: security
import { expect, test } from "bun:test";
import { safeErrorMessage } from "../../packages/butler-app/client/ui/src/app/notifications.ts";

test("client notifications hide Electron IPC wrapper errors from user copy", () => {
  const fallback = "ChatGPT 로그인을 시작할 수 없습니다.";
  const error = new Error(
    "Error invoking remote method 'butler:request-json': Error: Request failed.",
  );

  expect(safeErrorMessage(error, fallback)).toBe(fallback);
});

test("client notifications keep ordinary safe error details", () => {
  expect(safeErrorMessage(new Error("Model catalog failed"), "Fallback")).toBe(
    "Model catalog failed",
  );
});
