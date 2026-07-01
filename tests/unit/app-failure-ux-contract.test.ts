import { expect, test } from "bun:test";
import { appSafeResponderError } from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/failure-ux-contract.ts";

test("app failure UX contract does not expose raw timeout diagnostics", () => {
  const timeout = new Error(
    "timeout on /Users/example/.butler/socket token=secret",
  );
  timeout.name = "AppResponderTimeoutError";
  (timeout as Error & { code?: string }).code = "unsafe_timeout_token=secret";

  const safe = appSafeResponderError(timeout);

  expect(safe).toEqual({
    code: "gateway_timeout",
    message: "Butler did not finish the turn before the app timeout.",
  });
  expect(JSON.stringify(safe)).not.toContain("/Users/example");
  expect(JSON.stringify(safe)).not.toContain("token=secret");
});
