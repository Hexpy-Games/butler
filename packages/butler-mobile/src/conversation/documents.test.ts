// test-category: pure-logic
import { expect, test } from "bun:test";
import type { ProjectSourceContentPart } from "../../../butler-protocol/src/index.ts";
import { branchDestination, documentContent } from "./documents";

test("document content matches desktop and branches choose the destination", () => {
  const reference: ProjectSourceContentPart = { type: "project_source_ref", projectId: "project", titleSnapshot: "Plan",
    source: { kind: "plan", id: "plan", revision: "a".repeat(64) } };
  expect(documentContent("Continue", [reference])).toEqual({ version: 1, parts: [{ type: "text", text: "Continue" }, reference] });
  expect(branchDestination(false, "Next")).toEqual({ kind: "chat" });
  expect(branchDestination(false, "Next", "project")).toEqual({ kind: "project", projectId: "project" });
  expect(branchDestination(true, "Next", "project")).toEqual({ kind: "new_project", name: "Next" });
});
