import { afterEach, expect, test } from "bun:test";
import { getAppLocale, setAppCopyLanguage } from "./copy.ts";
import { projectDocumentReaderView } from "./projectDocumentReader.ts";
import type { ProjectDashboardDocument } from "./types.ts";

const locale = getAppLocale();
afterEach(() => setAppCopyLanguage(locale));
const document: ProjectDashboardDocument = {
  id: "SPEC-OAUTH", kind: "spec", title: "OAuth", status: "review", revision: "rev-2",
  safe_path_label: "specs/oauth.md", updated_at: "2026-09-09T06:40:00Z",
  markdown: "---\nid: SPEC-OAUTH\nkind: spec\nstatus: review\nowner: Team\n---\n# Scope\nOriginal text.",
};

test("reader separates primary facts, technical details and original body", () => {
  setAppCopyLanguage("ko");
  const view = projectDocumentReaderView(document);
  expect(view.facts.map((fact) => fact.id)).toEqual(["kind", "status", "updatedAt", "source"]);
  expect(view.facts.find((fact) => fact.id === "status")?.value).toBe("검토 중");
  expect(view.details.map((detail) => detail.key)).toEqual(["id", "revision", "owner"]);
  expect(view.body).toBe("# Scope\nOriginal text.");
});

test("reader follows interface locale, omits absent facts and never invents them", () => {
  setAppCopyLanguage("en");
  const view = projectDocumentReaderView({ ...document, status: undefined, updated_at: "", safe_path_label: "" });
  expect(view.facts).toHaveLength(1);
  expect(view.facts[0]?.label).toBe("Document type");
  expect(projectDocumentReaderView(document).facts[1]?.value).toBe("In review");
});
