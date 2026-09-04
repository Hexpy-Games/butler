import { describe, expect, it } from "bun:test";
import { modelPathPassed } from "./evidence.ts";

describe("modelPathPassed", () => {
  it("accepts an unproxied provider from the durable requested route", () => {
    expect(modelPathPassed({
      expectedModel: "zai/glm-5.2",
      providerAgentModels: [],
      providerReportedModel: "zai/glm-5.3",
      requestedModelRef: "zai/glm-5.2",
    })).toBe(true);
  });

  it("retains exact provider observation checks when requests are proxied", () => {
    expect(modelPathPassed({
      expectedModel: "openai/gpt-5.6-luna",
      providerAgentModels: ["gpt-5.6-luna"],
      providerReportedModel: "openai/gpt-5.6-luna",
      requestedModelRef: "openai/gpt-5.6-luna",
    })).toBe(true);
    expect(modelPathPassed({
      expectedModel: "openai/gpt-5.6-luna",
      providerAgentModels: ["gpt-5.6-luna"],
      providerReportedModel: "openai/gpt-5.6-sol",
      requestedModelRef: "openai/gpt-5.6-luna",
    })).toBe(false);
  });
});
