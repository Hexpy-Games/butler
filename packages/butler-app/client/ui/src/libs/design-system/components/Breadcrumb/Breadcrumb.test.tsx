/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbList } from "./index";

test("the trail and the ellipsis take their accessible names from props (localized by callers)", () => {
  const html = renderToStaticMarkup(
    <Breadcrumb label="현재 위치"><BreadcrumbList><li><BreadcrumbEllipsis label="더보기" /></li></BreadcrumbList></Breadcrumb>,
  );
  expect(html).toContain('aria-label="현재 위치"');
  expect(html).toContain(">더보기</span>");
  expect(html).not.toContain('aria-label="breadcrumb"');
  expect(html).not.toContain(">More<");
});
