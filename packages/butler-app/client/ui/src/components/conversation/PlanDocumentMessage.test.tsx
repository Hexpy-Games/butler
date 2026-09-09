import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanDocumentMessage } from "./PlanDocumentMessage";

test("renders the projected Plan in the shared Ledger markdown document box", () => {
  const html = renderToStaticMarkup(
    <PlanDocumentMessage
      plan={{
        id: "plan-1",
        title: "Ship composer Plan mode",
        status: "draft",
        markdown: [
          "---",
          'schema: "project-ledger.plan.v1"',
          "status: draft",
          "---",
          "# Objective",
          "Use **one** Ledger Plan.",
        ].join("\n"),
      }}
    />,
  );

  expect(html).toContain('data-test-class="plan-document-message"');
  expect(html).toContain('id="plan-document-plan-1"');
  expect(html).toContain("Ship composer Plan mode");
  expect(html).toContain("Objective");
  expect(html).toContain("<strong>one</strong>");
  expect(html).toContain('data-test-class="project-document-frontmatter"');
  expect(html).not.toContain("project-ledger.plan.v1");
});
