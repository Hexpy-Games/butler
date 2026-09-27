import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Project } from "ts-morph";
import { isGeometryOnly, planFile } from "../../packages/butler-app/scripts/codemods/ds-unsafe-style.ts";

const ds = join(process.cwd(), "packages/butler-app/client/ui/src/libs/design-system");
const product = join(process.cwd(), "packages/butler-app/client/ui/src/components/demo/Demo.tsx");

function plan(source: string) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4, strict: true } });
  project.createSourceFile(join(ds, "components/Row/Row.tsx"), `
    export type UnsafeStyle = { width?: string | number; transform?: string; [custom: \`--\${string}\`]: string | number | undefined };
    export function Row(props: { children?: unknown; className?: string; style?: object; UNSAFE_style?: UnsafeStyle }) { return null; }
    export function Plain(props: { children?: unknown; className?: string; style?: object }) { return null; }
  `);
  const file = project.createSourceFile(product, source);
  return planFile(file).map(({ line, tag, attribute, action }) => ({ line, tag, attribute, action }));
}

describe("ds-unsafe-style codemod", () => {
  test("geometry means sizes, transform, inset and custom properties only", () => {
    expect(isGeometryOnly(["width", "maxHeight", "transform", "--sidebar-width"])).toBe(true);
    expect(isGeometryOnly(["width", "color"])).toBe(false);
  });

  test("renames geometry-only style on components that offer UNSAFE_style and reports everything else", () => {
    const findings = plan(`
      import { Plain, Row } from "../../libs/design-system/components/Row/Row";
      export const a = <Row style={{ transform: "translateY(4px)" }} />;
      export const b = <Row style={{ color: "red" }} />;
      export const c = <Plain style={{ width: 4 }} />;
      export const d = <Row className="x" />;
      export const e = <div style={{ color: "red" }} />;
    `);
    expect(findings).toEqual([
      { line: 3, tag: "Row", attribute: "style", action: "rename" },
      { line: 4, tag: "Row", attribute: "style", action: "report" },
      { line: 5, tag: "Plain", attribute: "style", action: "report" },
      { line: 6, tag: "Row", attribute: "className", action: "report" },
    ]);
  });
});
