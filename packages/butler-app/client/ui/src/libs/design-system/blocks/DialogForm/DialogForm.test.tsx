/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "../../components/Dialog";
import { DialogForm } from "./DialogForm";

function render(node: React.ReactElement) {
  return new JSDOM(renderToStaticMarkup(node)).window.document;
}

test("inside a Dialog, the visible title and description are the dialog's title and description", () => {
  const document = render(
    <Dialog open>
      <DialogForm dialog title="Rename conversation" description="A short name." busy>{null}</DialogForm>
    </Dialog>,
  );
  const form = document.querySelector("form")!;
  expect(form.getAttribute("aria-busy")).toBe("true");
  expect(form.querySelector('[data-slot="dialog-title"]')!.textContent).toBe("Rename conversation");
  expect(form.querySelector('[data-slot="dialog-description"]')!.textContent).toBe("A short name.");
});

test("outside a Dialog the title is plain panel text", () => {
  const document = render(<DialogForm title="New project">{null}</DialogForm>);
  expect(document.querySelector('[data-slot="dialog-title"]')).toBeNull();
  expect(document.querySelector("form")!.textContent).toContain("New project");
});
