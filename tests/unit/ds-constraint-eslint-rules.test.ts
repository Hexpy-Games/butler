import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { butlerDsEslintPlugin } from "../../packages/butler-app/scripts/lint/butler-ds/eslint-plugin.ts";

type RuleTesterHooks = { describe: unknown; it: unknown; itOnly: unknown };
Object.assign(RuleTester as unknown as RuleTesterHooks, { describe, it, itOnly: it.only });

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});
const rules = butlerDsEslintPlugin.rules;

describe("butler-ds/no-classname-on-ds", () => {
  tester.run("no-classname-on-ds", rules["no-classname-on-ds"], {
    valid: [
      'import { Button } from "@/butler-ds"; const a = <Button variant="ghost" />;',
      'import { Button } from "./Button"; const a = <Button className="x" />;',
      'import styles from "./A.module.css"; const a = <div className={styles.root} />;',
      'import { Typo } from "@/butler-ds"; const a = <Typo.Body tone="muted" />;',
    ],
    invalid: [
      {
        code: 'import { Button } from "@/butler-ds"; const a = <Button className="x" />;',
        errors: [{ messageId: "classNameOnDs", data: { name: "Button" } }],
      },
      {
        code: 'import { Typo } from "@/butler-ds"; const a = <Typo.Body className={s.x} />;',
        errors: [{ messageId: "classNameOnDs", data: { name: "Typo.Body" } }],
      },
      {
        code: 'import { NavRow as Row } from "@/butler-ds/blocks/NavRow"; const a = <Row className="x" />;',
        errors: [{ messageId: "classNameOnDs", data: { name: "Row" } }],
      },
      {
        code: 'import { Button } from "@/butler-ds/shadcn/ui/button"; const a = <Button className="x" />;',
        errors: [{ messageId: "classNameOnDs" }],
      },
      {
        code: 'import * as DS from "@/libs/design-system"; const a = <DS.Card className="x" />;',
        errors: [{ messageId: "classNameOnDs", data: { name: "DS.Card" } }],
      },
      {
        code: 'import { Card } from "../../libs/design-system/components/Card"; const a = <Card className="x" />;',
        errors: [{ messageId: "classNameOnDs" }],
      },
    ],
  });
});

describe("butler-ds/no-inline-style", () => {
  tester.run("no-inline-style", rules["no-inline-style"], {
    valid: [
      "const a = <div />;",
      "const a = <Box UNSAFE_style={{ width: 1 }} />;",
      'const series = { color: "var(--chart-1)", label: "Work" };',
      "const layout = { width: 10, height: 20 };",
    ],
    invalid: [
      { code: "const a = <div style={{ width: 1 }} />;", errors: [{ messageId: "styleProp" }] },
      { code: "const a = <Button style={style} />;", errors: [{ messageId: "styleProp" }] },
      {
        code: 'import type { CSSProperties } from "react"; const s: CSSProperties = { width: 1 };',
        errors: [{ messageId: "styleObject" }],
      },
      {
        code: "const s: React.CSSProperties = { width: 1 };",
        errors: [{ messageId: "styleObject" }],
      },
      {
        code: "const s = { width: 1 } as CSSProperties;",
        errors: [{ messageId: "styleObject" }],
      },
      {
        code: 'const s = { fontSize: "13px", lineHeight: 1.2 };',
        errors: [{ messageId: "styleObject" }],
      },
      {
        code: 'const s = { backgroundColor: "#fff" };',
        errors: [{ messageId: "styleObject" }],
      },
    ],
  });
});

describe("butler-ds/no-raw-interactive", () => {
  tester.run("no-raw-interactive", rules["no-raw-interactive"], {
    valid: [
      'import { Button } from "@/butler-ds"; const a = <Button />;',
      'const a = <a href="https://example.com">x</a>;',
      "const a = <a href={url} onClick={track}>x</a>;",
      'const a = <input type="file" hidden />;',
      'const a = <input type="hidden" value="x" />;',
      'const a = <div role="presentation" />;',
    ],
    invalid: [
      { code: "const a = <button type=\"button\" />;", errors: [{ messageId: "rawInteractive", data: { tag: "button" } }] },
      { code: "const a = <input value={v} />;", errors: [{ messageId: "rawInteractive", data: { tag: "input" } }] },
      { code: "const a = <input type=\"checkbox\" />;", errors: [{ messageId: "rawInteractive" }] },
      { code: "const a = <select />;", errors: [{ messageId: "rawInteractive", data: { tag: "select" } }] },
      { code: "const a = <textarea />;", errors: [{ messageId: "rawInteractive", data: { tag: "textarea" } }] },
      { code: "const a = <a onClick={go}>x</a>;", errors: [{ messageId: "anchorButton" }] },
    ],
  });
});

describe("butler-ds/no-raw-typography", () => {
  tester.run("no-raw-typography", rules["no-raw-typography"], {
    valid: [
      "const a = <p>plain</p>;",
      "const a = <span aria-hidden>x</span>;",
      'import { Typo } from "@/butler-ds"; const a = <Typo.Body>x</Typo.Body>;',
      "const a = <div className={s.row} />;",
    ],
    invalid: [
      { code: "const a = <p className={s.x}>x</p>;", errors: [{ messageId: "rawTypography", data: { tag: "p" } }] },
      { code: "const a = <span className=\"x\">x</span>;", errors: [{ messageId: "rawTypography", data: { tag: "span" } }] },
      { code: "const a = <h1 className={s.title}>x</h1>;", errors: [{ messageId: "rawTypography", data: { tag: "h1" } }] },
      { code: "const a = <h6 className={s.title}>x</h6>;", errors: [{ messageId: "rawTypography", data: { tag: "h6" } }] },
    ],
  });
});

describe("butler-ds/unsafe-style-allowlist", () => {
  tester.run("unsafe-style-allowlist", rules["unsafe-style-allowlist"], {
    valid: [
      "const a = <div />;",
      'import { Stack } from "@/butler-ds"; const a = <Stack gap="sm" />;',
    ],
    invalid: [
      {
        code: 'import { MessageRow } from "@/butler-ds"; const a = <MessageRow UNSAFE_style={{ transform: t }} />;',
        errors: [{ messageId: "unsafeStyle", data: { name: "MessageRow" } }],
      },
      {
        code: "const a = <Anything UNSAFE_style={geometry} />;",
        errors: [{ messageId: "unsafeStyle", data: { name: "Anything" } }],
      },
    ],
  });
});
