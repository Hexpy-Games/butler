// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPreview, ArtifactPreviewFrame } from "./index";

test("ArtifactPreviewFrame fills the preview by default", () => {
  const markup = renderToStaticMarkup(<ArtifactPreview><ArtifactPreviewFrame src="about:blank" title="Report" /></ArtifactPreview>);
  expect(markup).not.toContain("data-intrinsic");
  expect(markup).not.toContain("style=");
});

test("ArtifactPreviewFrame with intrinsicSize takes exactly that CSS size and keeps the sandbox", () => {
  const markup = renderToStaticMarkup(<ArtifactPreviewFrame srcDoc="<p>x</p>" title="Clipped card" sandbox="" intrinsicSize={{ width: 320.5, height: 140 }} />);
  expect(markup).toContain('data-intrinsic=""');
  expect(markup).toContain("width:320.5px");
  expect(markup).toContain("height:140px");
  expect(markup).toContain('sandbox=""');
  expect(markup).toContain('title="Clipped card"');
});
