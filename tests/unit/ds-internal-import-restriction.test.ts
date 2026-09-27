import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ESLint } from "eslint";

const ui = join(process.cwd(), "packages/butler-app/client/ui/src");

async function restrictedImports(file: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath: join(ui, file) });
  return (result?.messages ?? []).filter((message) => message.ruleId === "no-restricted-imports").map((message) => message.message);
}

describe("lib/internal is DS-private", () => {
  test("product code cannot import the DS styling capability", async () => {
    for (const source of ["@/butler-ds/lib/internal", "@/libs/design-system/lib/internal", "../../libs/design-system/lib/internal.ts"]) {
      const messages = await restrictedImports("components/demo/Demo.tsx", `import { dsClass } from "${source}";\nexport const a = dsClass;\n`);
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain("design system");
    }
    const typeOnly = await restrictedImports("components/demo/Demo.tsx", 'import type { DsClassName } from "@/butler-ds/lib/internal";\nexport type A = DsClassName;\n');
    expect(typeOnly.length).toBe(1);
  });

  test("design-system code may import it", async () => {
    expect(await restrictedImports("libs/design-system/blocks/Demo/Demo.tsx", 'import { dsClass } from "../../lib/internal";\nexport const a = dsClass;\n')).toEqual([]);
  });
});
