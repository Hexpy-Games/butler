// test-category: pure-logic
import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { butlerDsEslintPlugin } from "../../packages/butler-app/scripts/lint/butler-ds/eslint-plugin.ts";

type RuleTesterHooks = { describe: unknown; it: unknown; itOnly: unknown };
const rejectOnly = () => {
  throw new Error("RuleTester cases marked only are not allowed in the full suite.");
};
Object.assign(RuleTester as unknown as RuleTesterHooks, { describe, it, itOnly: rejectOnly });

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

describe("butler-ds/settings-field-grouping", () => {
  const ds = 'import { Button, IconButton, Inline, Input, SegmentedControl, Select, SettingsActionField, SettingsField, SettingsFieldGroup, SettingsSection, Stack, Tooltip } from "@/butler-ds";';
  tester.run("settings-field-grouping", rules["settings-field-grouping"], {
    valid: [
      `${ds} const a = <SettingsSection id="s" kind="form"><SettingsField label="A" control={c} /><SettingsField label="B" control={c} /></SettingsSection>;`,
      `${ds} const a = <><SettingsField label="A" control={c} />{on && <SettingsField label="B" control={c} />}</>;`,
      `${ds} const a = <SettingsFieldGroup id="g"><SettingsField label="A" control={c} /><SettingsField label="B" control={c} /></SettingsFieldGroup>;`,
      `${ds} const a = <Stack gap="none"><SettingsField label="A" control={c} /></Stack>;`,
      `${ds} const a = <Stack align="row"><Stack.Item basis="lg"><SettingsFieldGroup><SettingsField label="A" control={c} /></SettingsFieldGroup></Stack.Item></Stack>;`,
      `${ds} const a = <Stack gap="sm"><Button>Copy</Button><Button>Paste</Button></Stack>;`,
      `${ds} const a = <SettingsSection id="s" kind="list" title="T" actions={<Button variant="outline" size="sm">Add</Button>}>{rows}</SettingsSection>;`,
      `${ds} const a = <SettingsSection id="s" kind="status" title="T" actions={<><SegmentedControl options={o} value={v} /><Button variant="outline" size="icon-sm">R</Button></>}>{facts}</SettingsSection>;`,
      `${ds} const a = <SettingsSection id="s" kind="list" title="T" actions={<><Select value={p} /><Tooltip label="x"><Button variant="outline" size="sm">Import</Button></Tooltip></>}>{rows}</SettingsSection>;`,
      `${ds} const a = <SettingsActionField label="Reset" description="Erases it." action={<Button>Reset</Button>} />;`,
    ],
    invalid: [
      {
        code: `${ds} const a = <Stack gap="md"><SettingsField label="A" control={c} /><SettingsField label="B" control={c} /></Stack>;`,
        errors: [{ messageId: "gapWrapper", data: { wrapper: "Stack", child: "SettingsField" } }],
      },
      {
        code: `${ds} const a = <Stack>{open ? <SettingsActionField label="A" description="B" action={x} /> : null}</Stack>;`,
        errors: [{ messageId: "gapWrapper", data: { wrapper: "Stack", child: "SettingsActionField" } }],
      },
      {
        code: `${ds} const a = <Inline>{items.map((item) => <SettingsField key={item} label={item} control={c} />)}</Inline>;`,
        errors: [{ messageId: "gapWrapper", data: { wrapper: "Inline", child: "SettingsField" } }],
      },
      {
        code: `${ds} const a = <Stack gap="md"><SettingsSection id="a" kind="form" /><SettingsSection id="b" kind="form" /></Stack>;`,
        errors: [{ messageId: "gapWrapper", data: { wrapper: "Stack", child: "SettingsSection" } }],
      },
      {
        code: `${ds} const a = <div gap="12px"><SettingsField label="A" control={c} /></div>;`,
        errors: [{ messageId: "gapWrapper", data: { wrapper: "div", child: "SettingsField" } }],
      },
      {
        code: `${ds} const a = <SettingsSection id="s" kind="form" title="T" actions={<Button variant="outline" size="sm">Reset</Button>}>{fields}</SettingsSection>;`,
        errors: [{ messageId: "headerAction" }],
      },
      {
        code: `${ds} const a = <SettingsSection id="s" kind={kind} title="T" actions={<Button variant="outline" size="sm">Reset</Button>} />;`,
        errors: [{ messageId: "headerAction" }],
      },
      {
        code: `${ds} const a = <SettingsSection id="s" kind="list" title="T" actions={<Button size="sm">Add</Button>}>{rows}</SettingsSection>;`,
        errors: [{ messageId: "headerButton" }],
      },
      {
        code: `${ds} const a = <SettingsSection id="s" kind="status" title="T" actions={<IconButton label="Refresh">R</IconButton>}>{facts}</SettingsSection>;`,
        errors: [{ messageId: "headerButton" }],
      },
      {
        code: `${ds} const a = <SettingsSection id="s" kind="list" title="T" actions={<><Input type="number" value={n} /><Button variant="outline" size="sm">Add</Button></>}>{rows}</SettingsSection>;`,
        errors: [{ messageId: "headerSetting", data: { control: "Input" } }],
      },
    ],
  });
});

describe("butler-ds/switch-field-layout", () => {
  const ds = 'import { Field, FieldContent, FieldLabel, Inline, Label, Stack, Switch, Typo } from "@/butler-ds";';
  tester.run("switch-field-layout", rules["switch-field-layout"], {
    valid: [
      `${ds} const a = <Field><FieldLabel htmlFor="s">Live</FieldLabel><Switch id="s" /></Field>;`,
      `${ds} const a = <Field orientation="horizontal"><FieldContent><FieldLabel htmlFor="s">Live</FieldLabel></FieldContent><Switch id="s" /></Field>;`,
      `${ds} const a = <Stack gap="xs"><Label htmlFor="s">Live</Label><Switch id="s" /></Stack>;`,
      `${ds} const a = <Stack align="row"><Switch aria-label="On" /><Switch aria-label="Off" /></Stack>;`,
      'import { Stack, Typo } from "@/butler-ds"; import { Switch } from "./Switch"; const a = <Stack align="row"><Typo.Label>Live</Typo.Label><Switch /></Stack>;',
    ],
    invalid: [
      {
        code: `${ds} const a = <Stack align="row" cross="center"><Switch aria-label="Live" /><Typo.Caption>Live</Typo.Caption></Stack>;`,
        errors: [{ messageId: "rowSwitchField", data: { wrapper: "Stack" } }],
      },
      {
        code: `${ds} const a = <Stack align="row" justify="between"><Typo.Label>Live</Typo.Label><Switch aria-label="Live" /></Stack>;`,
        errors: [{ messageId: "rowSwitchField", data: { wrapper: "Stack" } }],
      },
      {
        code: `${ds} const a = <Inline gap="xs"><Label htmlFor="s">Live</Label><Switch id="s" /></Inline>;`,
        errors: [{ messageId: "rowSwitchField", data: { wrapper: "Inline" } }],
      },
    ],
  });
});

describe("butler-ds/no-leading-disclosure-chevron", () => {
  const ds = 'import { Clickable, ChevronDown, ChevronRight, Typo } from "@/butler-ds";';
  tester.run("no-leading-disclosure-chevron", rules["no-leading-disclosure-chevron"], {
    valid: [
      `${ds} const a = <Clickable aria-expanded={open}><Typo.Body>Title</Typo.Body><ChevronRight /></Clickable>;`,
      `${ds} const a = <Clickable aria-expanded={open}><span><Typo.Body>Title</Typo.Body>{open ? <ChevronDown /> : <ChevronRight />}</span></Clickable>;`,
      `${ds} const a = <Clickable aria-expanded={open} icon={<Wrench />}><Typo.Body>Title</Typo.Body></Clickable>;`,
      `${ds} const a = <Clickable><ChevronRight /><Typo.Body>Next</Typo.Body></Clickable>;`,
    ],
    invalid: [
      {
        code: `${ds} const a = <Clickable aria-expanded={open}>{open ? <ChevronDown /> : <ChevronRight />}<Typo.Body>Title</Typo.Body></Clickable>;`,
        errors: [{ messageId: "leadingChild" }],
      },
      {
        code: `${ds} const a = <button aria-expanded={open}>\n  <span>{open ? <ChevronDown size="sm" /> : <ChevronRight size="sm" />}</span>\n  <span>Title</span>\n</button>;`,
        errors: [{ messageId: "leadingChild" }],
      },
      {
        code: `${ds} const a = <Button aria-expanded={open} icon={<ChevronRight />}>Details</Button>;`,
        errors: [{ messageId: "startIconProp", data: { prop: "icon" } }],
      },
    ],
  });
});
