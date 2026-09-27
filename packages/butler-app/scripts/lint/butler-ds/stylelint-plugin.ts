import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";

const {
  createPlugin,
  utils: { report, ruleMessages, validateOptions },
} = stylelint;

const designSystemRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "client", "ui", "src", "libs", "design-system",
);

type Root = Parameters<ReturnType<stylelint.Rule>>[0];
type Declaration = Parameters<Parameters<Root["walkDecls"]>[0]>[0];
type CssRule = Parameters<Parameters<Root["walkRules"]>[0]>[0];

const GLOBAL_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

/** Removes var(...) and env(...) calls, fallbacks included, so only raw values remain. */
function stripTokenCalls(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const match = /(?:var|env)\(/iu.exec(value.slice(index));
    if (!match) return output + value.slice(index);
    output += value.slice(index, index + match.index);
    let depth = 0;
    let cursor = index + match.index + match[0].length - 1;
    for (; cursor < value.length; cursor += 1) {
      if (value[cursor] === "(") depth += 1;
      if (value[cursor] === ")") depth -= 1;
      if (depth === 0) break;
    }
    output += " ";
    index = cursor + 1;
  }
  return output;
}

const NAMED_COLORS = [
  "white", "black", "red", "green", "blue", "gray", "grey", "yellow", "orange", "purple", "pink",
  "silver", "navy", "teal", "maroon", "olive", "lime", "aqua", "fuchsia", "cyan", "magenta", "brown",
  "gold", "indigo", "violet",
];
const RAW_COLOR = new RegExp(
  `#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|(?<![\\w-])(?:${NAMED_COLORS.join("|")})(?![\\w-])`,
  "iu",
);
const COLOR_PROPERTY =
  /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?)$/u;
const SPACING_PROPERTY =
  /^(?:(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap|inset(?:-(?:block|inline)(?:-(?:start|end))?)?|top|right|bottom|left)$/u;
const RADIUS_PROPERTY = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/u;
const MOTION_PROPERTY = /^(?:transition|animation)(?:-(?:duration|delay|timing-function))?$/u;
const LENGTH = /(?<![\w-])(-?\d*\.?\d+)(px|rem|em|ch|ex|vh|vw|vmin|vmax|dvh|svh|lvh|dvw|svw|lvw|lh|pt|cm|mm|in|cqw|cqh|cqi|cqb)(?![\w-])/giu;
const TIME = /(?<![\w-])(\d*\.?\d+)(ms|s)(?![\w-])/giu;
const RAW_EASING = /\b(?:cubic-bezier|steps|linear)\(|(?<![\w-])(?:ease|ease-in|ease-out|ease-in-out|step-start|step-end)(?![\w-])/iu;

function rawLengths(value: string, allow: (amount: number, unit: string) => boolean): boolean {
  return [...value.matchAll(LENGTH)].some((match) => !allow(Number(match[1]), match[2].toLowerCase()));
}

function onlyKeywords(value: string, extra: readonly string[] = []): boolean {
  const rest = value.trim().toLowerCase();
  return rest === "" || GLOBAL_KEYWORDS.has(rest) || extra.includes(rest);
}

/** Returns the raw-value category a declaration violates, or null. */
export function rawValueCategory(property: string, value: string): string | null {
  const prop = property.toLowerCase();
  const raw = stripTokenCalls(value);
  if (prop.startsWith("--")) return RAW_COLOR.test(raw) ? "color" : null;
  if (COLOR_PROPERTY.test(prop) && RAW_COLOR.test(raw)) return "color";
  if (SPACING_PROPERTY.test(prop)) {
    // Exceptions: 0, auto and percentages. Hairline offsets use var(--border-hairline).
    return rawLengths(raw, (amount) => amount === 0) ? "spacing" : null;
  }
  if (RADIUS_PROPERTY.test(prop)) return rawLengths(raw, (amount) => amount === 0) ? "radius" : null;
  if (prop === "z-index") return onlyKeywords(raw, ["auto", "0"]) ? null : "z-index";
  if (MOTION_PROPERTY.test(prop)) {
    const rawTime = [...raw.matchAll(TIME)].some((match) => Number(match[1]) !== 0);
    // `linear` stays allowed for loops such as spinners.
    return rawTime || RAW_EASING.test(raw) ? "motion" : null;
  }
  if (prop === "font-size" || prop === "font-weight") return onlyKeywords(raw) ? null : "typography";
  if (prop === "line-height") return onlyKeywords(raw, ["1", "normal"]) ? null : "typography";
  if (prop === "font") return onlyKeywords(raw.replaceAll("/", " ")) ? null : "typography";
  return null;
}

type RuleFunction = stylelint.Rule;

function defineRule(
  name: string,
  messages: Record<string, (...args: string[]) => string>,
  lint: (root: Root, result: stylelint.PostcssResult, messages: Record<string, (...args: string[]) => string>, secondary: unknown) => void,
): stylelint.Plugin {
  const ruleName = `butler-ds/${name}`;
  const ruleMessagesFor = ruleMessages(ruleName, messages);
  const ruleFunction: RuleFunction = (primary, secondary) => (root, result) => {
    if (!validateOptions(result, ruleName, { actual: primary })) return;
    lint(root, result, ruleMessagesFor as Record<string, (...args: string[]) => string>, secondary);
  };
  ruleFunction.ruleName = ruleName;
  ruleFunction.messages = ruleMessagesFor;
  ruleFunction.meta = { url: "packages/butler-app/scripts/lint/README.md" };
  return createPlugin(ruleName, ruleFunction);
}

function reportOn(node: Declaration | CssRule, result: stylelint.PostcssResult, ruleName: string, message: string): void {
  report({ node, result, ruleName, message });
}

const tokenOnlyValues = defineRule(
  "token-only-values",
  {
    rejected: (property, value, category) =>
      `"${property}: ${value}" uses a raw ${category} value; use a design token var(--token)`,
  },
  (root, result, messages) => {
    root.walkDecls((decl) => {
      const category = rawValueCategory(decl.prop, decl.value);
      if (category) reportOn(decl, result, "butler-ds/token-only-values", messages.rejected(decl.prop, decl.value, category));
    });
  },
);

const DS_ATTRIBUTE = /\[\s*(data-(?:slot|state|side|align|orientation|highlighted|radix-[\w-]*|ds-[\w-]*))\b/u;
const THEME_CLASSES = new Set(["theme-dark", "theme-light"]);
const NTH_PSEUDO = /:(?:nth-child|nth-last-child|nth-of-type|nth-last-of-type|lang|dir)\([^)]*\)/gu;

function globalClasses(selector: string): string[] {
  return [...selector.matchAll(/:global\(([^)]*)\)/gu)]
    .flatMap((match) => [...match[1].matchAll(/\.([\w-]+)/gu)].map((cls) => cls[1]));
}

/** Returns why a product selector reaches into DS internals, or null. */
export function dsInternalSelectorReason(selector: string): string | null {
  const attribute = DS_ATTRIBUTE.exec(selector);
  if (attribute) return `targets DS attribute [${attribute[1]}]`;
  const dsClass = globalClasses(selector).find((name) => !THEME_CLASSES.has(name));
  if (dsClass) return `targets global class .${dsClass}`;
  const compounds = selector
    .replace(/"[^"]*"|'[^']*'/gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/:global\([^)]*\)/gu, " ")
    .replace(NTH_PSEUDO, "")
    .replace(/::?[\w-]+/gu, " ")
    .split(/[\s>+~,()]+/u);
  const element = compounds.find((compound) => /^[a-z][\w-]*/iu.test(compound));
  return element ? `targets element ${element.match(/^[a-z][\w-]*/iu)?.[0]}` : null;
}

const noDsInternalSelector = defineRule(
  "no-ds-internal-selector",
  {
    rejected: (selector, reason) =>
      `Selector "${selector}" ${reason}; style only classes this module owns and use DS props for DS internals`,
  },
  (root, result, messages) => {
    root.walkRules((rule) => {
      const parent = rule.parent as { type?: string; name?: string } | undefined;
      if (parent?.type === "atrule" && /keyframes$/iu.test(parent.name ?? "")) return;
      for (const selector of rule.selectors) {
        const reason = dsInternalSelectorReason(selector);
        if (reason) reportOn(rule, result, "butler-ds/no-ds-internal-selector", messages.rejected(selector, reason));
      }
    });
  },
);

function walkCss(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walkCss(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

let cachedDsProperties: Set<string> | null = null;

/** Every custom property the design-system CSS defines or reads. */
export function defaultDsCustomProperties(): Set<string> {
  if (cachedDsProperties) return cachedDsProperties;
  const properties = new Set<string>();
  for (const path of walkCss(designSystemRoot)) {
    const css = readFileSync(path, "utf8");
    for (const match of css.matchAll(/(--[\w-]+)\s*:/gu)) properties.add(match[1]);
    for (const match of css.matchAll(/var\(\s*(--[\w-]+)/gu)) properties.add(match[1]);
  }
  cachedDsProperties = properties;
  return properties;
}

type OverrideOptions = { properties?: string[]; prefixes?: string[] };

const noDsCustomPropOverride = defineRule(
  "no-ds-custom-prop-override",
  {
    rejected: (property) =>
      `Do not set design-system custom property ${property} in product CSS; use a DS prop or request a DS capability`,
  },
  (root, result, messages, secondary) => {
    const options = (secondary ?? {}) as OverrideOptions;
    const properties = options.properties ? new Set(options.properties) : defaultDsCustomProperties();
    const prefixes = options.prefixes ?? [];
    root.walkDecls(/^--/u, (decl) => {
      if (properties.has(decl.prop) || prefixes.some((prefix) => decl.prop.startsWith(prefix))) {
        reportOn(decl, result, "butler-ds/no-ds-custom-prop-override", messages.rejected(decl.prop));
      }
    });
  },
);

/** True when a custom property value carries a raw, non-zero length outside var()/env(). */
export function hasRawLengthCustomProperty(property: string, value: string): boolean {
  if (!property.startsWith("--")) return false;
  return rawLengths(stripTokenCalls(value), (amount) => amount === 0);
}

// Warning only: reported by lint:ds but not ratcheted yet (ratchet planned for roadmap step 4 S5).
const noRawLengthCustomProp = defineRule(
  "no-raw-length-custom-prop",
  {
    rejected: (property, value) =>
      `Custom property "${property}: ${value}" hides a raw length; derive it from design tokens or request a DS capability`,
  },
  (root, result, messages) => {
    root.walkDecls(/^--/u, (decl) => {
      if (hasRawLengthCustomProperty(decl.prop, decl.value)) {
        reportOn(decl, result, "butler-ds/no-raw-length-custom-prop", messages.rejected(decl.prop, decl.value));
      }
    });
  },
);

export const butlerDsStylelintPlugins = [tokenOnlyValues, noDsInternalSelector, noDsCustomPropOverride, noRawLengthCustomProp];
