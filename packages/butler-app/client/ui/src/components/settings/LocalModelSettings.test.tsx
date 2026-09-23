/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalModelSettings } from "./LocalModelSettings";
import { localModelPayload } from "./localModelApi";

test("Custom exposes manual model entry and masked API key before discovery", () => {
  const html = renderToStaticMarkup(<LocalModelSettings hideRegisteredList />);
  expect(html).toContain('id="custom-model-api-key"');
  expect(html).toContain('type="password"');
  expect(html).toContain('id="local-model-id"');
  expect(html).toContain('id="local-model-server-url"');
});

test("Custom registration preserves raw IDs and key keep, replace, remove semantics", () => {
  const payload = localModelPayload(null, "custom", "https://example.test/gateway/v4", "org/model", "My model", "32000", undefined, "test-key");
  expect(payload).toMatchObject({ model_id: "org/model", api_key: "test-key", source: "manual", context_window_tokens: 32000 });
  expect(localModelPayload(null, "custom", "http://localhost:8080", "model", "", "16000").api_key).toBeUndefined();
  expect(localModelPayload(null, "custom", "http://localhost:8080", "model", "", "16000", undefined, "").api_key).toBe("");
});
