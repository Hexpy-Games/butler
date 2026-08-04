/// <reference types="bun" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { FileText } from "../../components/Icons";
import { AttachmentList } from "./AttachmentList";

function readStyles() {
  return readFileSync(
    new URL("./AttachmentList.module.css", import.meta.url),
    "utf8",
  );
}

function cssRule(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    source.match(
      new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`, "u"),
    )?.[1] ?? ""
  );
}

test("renders image thumbnails before name, remove action, and size metadata", () => {
  const html = renderToStaticMarkup(
    <AttachmentList
      items={[
        {
          id: "image",
          name: "screenshot.png",
          meta: "142 KB",
          thumbnail: {
            alt: "Screenshot preview",
            src: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
          },
        },
      ]}
      onRemove={() => undefined}
      variant="chips"
    />,
  );

  const document = new JSDOM(html).window.document;
  const item = document.querySelector('[data-slot="attachment-item"]');
  if (!item) throw new Error("Missing attachment item");

  expect(
    item.querySelector('[data-slot="attachment-thumbnail"]'),
  ).not.toBeNull();
  expect(item.querySelector('img[alt="Screenshot preview"]')).not.toBeNull();
  expect(
    Array.from(item.children).map(
      (child) => child.getAttribute("data-slot") ?? child.tagName.toLowerCase(),
    ),
  ).toEqual([
    "attachment-thumbnail",
    "attachment-name",
    "button",
    "attachment-meta",
  ]);
});

test("ordinary files keep their icon and chip metadata follows the chip container", () => {
  const html = renderToStaticMarkup(
    <AttachmentList
      items={[
        { id: "text", name: "notes.md", meta: "4 KB", icon: <FileText /> },
      ]}
      variant="chips"
    />,
  );
  const document = new JSDOM(html).window.document;
  const list = document.querySelector('[data-slot="attachment-list"]');
  const item = document.querySelector('[data-slot="attachment-item"]');
  if (!list || !item) throw new Error("Missing attachment chip structure");
  const css = readStyles();
  const chipRule = cssRule(css, ".chips .item");
  const chipQuery =
    css.match(
      /@container\s+attachment-chip\s*\(width\s*<=\s*192px\)\s*\{([\s\S]*?)\}/u,
    )?.[1] ?? "";

  expect(list).not.toBeNull();
  expect(item).not.toBeNull();
  expect(item.querySelector('[data-slot="attachment-icon"]')).not.toBeNull();
  expect(item.querySelector('[data-slot="attachment-meta"]')).not.toBeNull();
  expect(chipRule).toMatch(/container-name:\s*attachment-chip/u);
  expect(chipRule).toMatch(/container-type:\s*inline-size/u);
  expect(chipQuery).toMatch(/\.meta\s*\{[\s\S]*?display:\s*none/su);
  expect(css).not.toMatch(/container-name:\s*attachment-list/u);
});
