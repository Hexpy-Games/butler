// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageViewerSurface } from "./index";
import { VIEWER_LABELS, viewerImages } from "./fixtures";

const labels = VIEWER_LABELS["en-US"];

test("a set shows its position, both page buttons, the caption and the source line", () => {
  const image = viewerImages("en-US")[0]!;
  const markup = renderToStaticMarkup(<ImageViewerSurface image={image} index={0} total={3} labels={labels}
    onNext={() => undefined} onClose={() => undefined} />);
  expect(markup).toContain("1 / 3");
  expect(markup).toContain('aria-label="Previous image"');
  expect(markup).toContain('aria-label="Next image"');
  expect(markup).toContain(image.caption!);
  expect(markup).toContain("shop.example.com · Checked 5:41 PM");
  expect(markup).toContain(`alt="${image.alt}"`);
});

test("a single picture has no position or paging, and no caption box without text", () => {
  const markup = renderToStaticMarkup(<ImageViewerSurface image={{ src: "data:,", alt: "Shot" }} index={0} total={1} labels={labels}
    onClose={() => undefined} />);
  expect(markup).not.toContain("1 / 1");
  expect(markup).not.toContain("Previous image");
  expect(markup).toContain('aria-label="Close"');
});
