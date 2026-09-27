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

test("KanbanBoard scroll keeps every lane at the minimum lane width in one row that scrolls sideways", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <KanbanBoard scroll data-test-class="board"><div>A</div><div>B</div><div>C</div><div>D</div><div>E</div><div>F</div></KanbanBoard>,
  )).window.document;
  const board = document.querySelector('[data-test-class="board"]')!;
  expect(board.getAttribute("data-scroll")).toBe("true");
  expect(board.children).toHaveLength(6);
  expect(document.body.innerHTML).not.toContain("style=");
  const rule = /\.board\[data-scroll="true"\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";
  expect(rule).toMatch(/grid-auto-flow:\s*column/u);
  expect(rule).toMatch(/grid-auto-columns:\s*minmax\(var\(--kanban-lane-min-width\),\s*1fr\)/u);
  expect(rule).toMatch(/overflow-x:\s*auto/u);
  expect(readFileSync(new URL("../../tokens.css", import.meta.url), "utf8")).toMatch(/--kanban-lane-min-width:\s*15rem/u);
});
