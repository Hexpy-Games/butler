/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { KanbanBoard, KanbanLane } from "./KanbanBoard";

const css = readFileSync(new URL("./KanbanBoard.module.css", import.meta.url), "utf8");

test("KanbanBoard lays lanes on a grid; lanes are fixed-height scrollers under a title", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <KanbanBoard data-test-class="board"><KanbanLane title="Draft"><p>One</p></KanbanLane><KanbanLane title="Done"><p>Two</p></KanbanLane></KanbanBoard>,
  )).window.document;
  const board = document.querySelector('[data-test-class="board"]')!;
  expect(board.getAttribute("data-columns")).toBe("4");
  expect(board.querySelectorAll('[data-slot="kanban-lane"]')).toHaveLength(2);
  expect(board.textContent).toContain("Draft");
  expect(document.body.innerHTML).not.toContain("style=");
  expect(css).toMatch(/height:\s*var\(--kanban-lane-height\)/u);
});
