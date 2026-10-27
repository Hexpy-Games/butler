import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type DesignSystemRuleFinding = {
  path: string;
  line: number;
  reason: string;
  text: string;
};

type CssRule = { selector: string; body: string; line: number };

function stripCssComments(source: string): string {
  // Keep newlines so rule line numbers stay accurate.
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function cssRules(source: string): CssRule[] {
  const css = stripCssComments(source);
  const rules: CssRule[] = [];
  for (const match of css.matchAll(/([^{};]*)\{([^{}]*)\}/gu)) {
    const selector = match[1].trim();
    const start = (match.index ?? 0) + match[1].length - match[1].trimStart().length;
    rules.push({
      selector,
      body: match[2],
      line: css.slice(0, start).split("\n").length,
    });
  }
  return rules;
}

function focusRingFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  if (!rule.selector.includes(":focus-visible")) return [];
  if (!/(?:^|;|\s)outline\s*:\s*none\b/u.test(rule.body)) return [];
  if (rule.body.includes("var(--focus-ring")) return [];
  return [{
    path,
    line: rule.line,
    reason: "outline: none in :focus-visible must draw the shared --focus-ring instead",
    text: rule.selector,
  }];
}

const Z_INDEX_TOKEN_THRESHOLD = 50;

function zIndexFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  return [...rule.body.matchAll(/(?:^|;|\s)z-index\s*:\s*(\d+)\s*(?:;|$)/gu)]
    .filter((match) => Number(match[1]) >= Z_INDEX_TOKEN_THRESHOLD)
    .map(() => ({
      path,
      line: rule.line,
      reason: `z-index of ${Z_INDEX_TOKEN_THRESHOLD} or more must use a var(--z-*) layering token`,
      text: rule.selector,
    }));
}

const SIZED_CONTROL_FILES = [
  "libs/design-system/components/Button/Button.module.css",
  "libs/design-system/components/IconButton/IconButton.module.css",
  "libs/design-system/components/DropdownMenu/DropdownMenu.module.css",
  "libs/design-system/components/ContextMenu/ContextMenu.module.css",
  "libs/design-system/components/Select/Select.module.css",
  "libs/design-system/blocks/OptionMenu/OptionMenu.module.css",
  "libs/design-system/blocks/FilteredSelectPopover/FilteredSelectPopover.module.css",
];

function rawHeightFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  if (!SIZED_CONTROL_FILES.some((file) => path.endsWith(file))) return [];
  return [...rule.body.matchAll(/(?:^|;|\s)((?:min-|max-)?height)\s*:\s*(\d+(?:\.\d+)?)px\s*(?:;|$)/gu)]
    // 1px hairline separators are not control heights.
    .filter((match) => Number(match[2]) !== 1)
    .map((match) => ({
      path,
      line: rule.line,
      reason: `raw px ${match[1]} in a control/menu stylesheet must use --control-height-* or --menu-item-height`,
      text: rule.selector,
    }));
}

const MOTION_DECLARATION = /(?:^|;|\s)((?:transition|animation)(?:-duration|-delay|-timing-function)?)\s*:\s*([^;]+)/gu;
// Any non-zero literal duration (120ms, .2s) or a raw cubic-bezier curve.
const RAW_MOTION_VALUE = /(?<![\w-])(?:(?!0+ms)\d*\.?\d+ms|\d*\.\d+s|[1-9]\d*s)(?![\w-])|cubic-bezier\(/u;

function rawMotionFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  if (path.endsWith("tokens.css")) return [];
  return [...rule.body.matchAll(MOTION_DECLARATION)]
    .filter((match) => RAW_MOTION_VALUE.test(match[2]))
    .map((match) => ({
      path,
      line: rule.line,
      reason: `raw ${match[1]} timing must use --motion-* duration and easing tokens`,
      text: rule.selector,
    }));
}

const SPACING_TOKENS: Record<string, string> = {
  "4": "--space-xs", "8": "--space-sm", "12": "--space-md", "16": "--space-lg", "20": "--space-xl", "24": "--space-2xl",
};
const RADIUS_TOKENS: Record<string, string> = {
  "8": "--radius-control", "10": "--radius-panel", "12": "--radius-popover", "22": "--radius-composer",
};
const SPACING_DECLARATION =
  /(?:^|;|\s)((?:padding|margin)(?:-(?:block|inline|top|bottom|left|right)(?:-start|-end)?)?|gap|row-gap|column-gap)\s*:\s*([^;]+)/gu;
const RADIUS_DECLARATION = /(?:^|;|\s)(border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius)\s*:\s*([^;]+)/gu;
const PX_VALUE = /(?<![\w.-])(\d+(?:\.\d+)?)px/gu;
// Values up to 3px are hairline borders and optical nudges, not layout spacing.
const HAIRLINE_MAX_PX = 3;

/**
 * Off-scale spacing/radius kept on purpose, keyed by path under the UI src
 * root as "spacing:<px>" or "radius:<px>". Add an entry only with a reason;
 * values on the token scale must always use the token.
 */
export const OFF_SCALE_ALLOWLIST: Record<string, readonly string[]> = {
  // Control and menu insets tuned to the 24-34px control heights and 32px menu rows.
  "libs/design-system/blocks/AttachmentList/AttachmentList.module.css": ["spacing:10"],
  // The 64px file face's 6px inset fits "DOCX" beside its glyph.
  "libs/design-system/blocks/AttachmentList/AttachmentTiles.module.css": ["spacing:6"],
  "libs/design-system/blocks/CommandPanel/CommandPanel.module.css": ["spacing:10", "spacing:14", "spacing:6"],
  "libs/design-system/blocks/FilteredSelectPopover/FilteredSelectPopover.module.css": ["spacing:32"],
  "libs/design-system/blocks/KeyValueRow/KeyValueRow.module.css": ["spacing:10"],
  "libs/design-system/components/Breadcrumb/Breadcrumb.module.css": ["spacing:6"],
  "libs/design-system/components/Button/Button.module.css": ["spacing:10", "spacing:14", "spacing:5"],
  "libs/design-system/components/Clickable/Clickable.module.css": ["spacing:10"],
  "libs/design-system/components/ContextMenu/ContextMenu.module.css": ["spacing:6", "spacing:9"],
  "libs/design-system/components/DropdownMenu/DropdownMenu.module.css": ["spacing:6", "spacing:9"],
  "libs/design-system/components/Input/Input.module.css": ["spacing:10", "spacing:7"],
  "libs/design-system/components/NativeSelect/NativeSelect.module.css": ["spacing:10", "spacing:34"],
  "libs/design-system/components/Select/Select.module.css": ["spacing:30", "spacing:6", "spacing:7", "spacing:9"],
  "libs/design-system/components/Textarea/Textarea.module.css": ["spacing:10", "spacing:9"],
  "libs/design-system/shadcn/ui/tooltip.module.css": ["spacing:6", "spacing:9"],
  // Shell geometry: titlebar/traffic-light offsets, page gutters and optical icon-column alignment.
  "libs/design-system/blocks/AdaptiveShell/AdaptiveShell.module.css": ["radius:18"],
  "libs/design-system/blocks/ConversationShell/ConversationShell.module.css": ["spacing:22"],
  "libs/design-system/blocks/ManagementPage/ManagementPage.module.css": ["spacing:22", "spacing:40", "spacing:48", "spacing:56"],
  "libs/design-system/blocks/NavRow/NavRow.module.css": ["spacing:17"],
  "libs/design-system/blocks/SettingsShell/SettingsShell.module.css": ["spacing:18", "spacing:28", "spacing:32", "spacing:60"],
  "libs/design-system/blocks/SidebarShell/SidebarShell.module.css": ["spacing:10", "spacing:14", "spacing:18"],
  // The setup card's top edge stops at 240px (20% of a 1200px window), intro spec rev 4.
  "libs/design-system/blocks/SetupWizardShell/SetupWizardShell.module.css": ["spacing:240"],
  "libs/design-system/blocks/TitlebarShell/TitlebarShell.module.css": ["spacing:18", "spacing:54"],
  // Reading rhythm and glass card radii of conversation and dashboard content.
  "components/management/ProjectInformation.module.css": ["spacing:30"],
  "libs/design-system/blocks/MessageRow/MessageRow.module.css": ["radius:14", "spacing:10", "spacing:18", "spacing:26", "spacing:28", "spacing:6"],
  // The viewport wallpaper's leading corners follow the workspace frame (--workspace-left-radius fallback).
  "libs/design-system/blocks/Wallpaper/Wallpaper.module.css": ["radius:18"],
  // Panel-size usage columns round their tops by 4px (owner-approved UsageBars spec, 2026-10-15).
  "libs/design-system/blocks/UsageBars/UsageBars.module.css": ["radius:4"],
  // The queued bubble must match the MessageRow user bubble box so a delivered message resolves in place.
  "libs/design-system/blocks/QueuedMessage/QueuedMessage.module.css": ["radius:14", "spacing:10", "spacing:6"],
  "libs/design-system/blocks/WorkActivityBlock/WorkActivityBlock.module.css": ["spacing:5"],
  // Visual harness layout, not product UI.
  "pages/ThinkingMarkHarness.module.css": ["radius:6", "spacing:10", "spacing:14", "spacing:18", "spacing:28", "spacing:44", "spacing:48"],
};

function allowedOffScale(path: string, entry: string): boolean {
  return Object.entries(OFF_SCALE_ALLOWLIST).some(([file, values]) =>
    path.endsWith(file) && values.includes(entry));
}

function rawScaleFindings(
  path: string,
  rule: CssRule,
  kind: "spacing" | "radius",
): DesignSystemRuleFinding[] {
  if (path.endsWith("tokens.css")) return [];
  const [declaration, scale, family] = kind === "spacing"
    ? [SPACING_DECLARATION, SPACING_TOKENS, "--space-*"]
    : [RADIUS_DECLARATION, RADIUS_TOKENS, "--radius-*"];
  return [...rule.body.matchAll(declaration)].flatMap((match) =>
    [...match[2].matchAll(PX_VALUE)].flatMap(([, value]) => {
      if (Number(value) <= HAIRLINE_MAX_PX) return [];
      const token = scale[value];
      if (!token && allowedOffScale(path, `${kind}:${value}`)) return [];
      return [{
        path,
        line: rule.line,
        reason: token
          ? `raw ${value}px ${match[1]} must use var(${token})`
          : `off-scale ${value}px ${match[1]} must use a ${family} token or be allow-listed with a reason`,
        text: rule.selector,
      }];
    }));
}

/**
 * 큰 글자 zooms the whole App UI by --ui-scale while corners keep their 100% size, so every px length in a
 * radius (a border-*-radius or a *radius* custom property) divides by var(--ui-scale) right after it.
 */
const RADIUS_VALUE = /(?:^|;|\s)(border(?:-[a-z]+)*-radius|--[a-z0-9-]*radius[a-z0-9-]*)\s*:\s*([^;]+)/gu;
const UNSCALED_PX = /(?<![\w.-])(?!0+(?:\.0+)?px)\d+(?:\.\d+)?px(?!\s*\/\s*var\(--ui-scale\))/u;

function unscaledRadiusFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  return [...rule.body.matchAll(RADIUS_VALUE)]
    .filter((match) => UNSCALED_PX.test(match[2]))
    .map((match) => ({
      path,
      line: rule.line,
      reason: `px in ${match[1]} must divide by var(--ui-scale) so the corner keeps its size under 큰 글자`,
      text: rule.selector,
    }));
}

/** Text takes an integer px line-height role token; unitless ratios are for display art only. */
const RATIO_LINE_HEIGHT = /(?:^|;|\s)line-height\s*:\s*(\d*\.\d+|var\(--line-height-(?:tight|snug|body|document)\))\s*(?:;|$)/u;
const RATIO_FONT_SHORTHAND = /(?:^|;|\s)font\s*:[^;]*\/\s*(\d*\.\d+|var\(--line-height-(?:tight|snug|body|document)\))/u;
const RATIO_ALLOWED = /libs\/design-system\/components\/FoundationHeroMotion\//u;

function ratioLineHeightFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  if (RATIO_ALLOWED.test(path.replaceAll("\\", "/"))) return [];
  const match = RATIO_LINE_HEIGHT.exec(rule.body) ?? RATIO_FONT_SHORTHAND.exec(rule.body);
  if (!match) return [];
  return [{ path, line: rule.line, reason: "line-height must be an integer px role token (--typo-*-line-height), not a ratio", text: `${rule.selector} { ${match[1]} }` }];
}

/**
 * A px line-height inherits as px, not as a ratio of the new size, so a rule
 * that sets a font-size token sets its line-height too. Ratchet: these
 * existing rules are not yet paired (icon boxes and mobile-only rules that
 * need their own check); the list may only shrink.
 */
const FONT_SIZE_TOKEN = /(?:^|;|\s)font-size\s*:\s*var\((--(?:typo-[a-z-]+-size(?:-md|-sm)?|font-size-\d))\)\s*(?:;|$)/u;
const LINE_HEIGHT_SET = /(?:^|;|\s)(?:line-height|font)\s*:/u;
const UNPAIRED_FONT_SIZE_RATCHET: Record<string, string[]> = {
  "blocks/ElementChip/ElementChip.module.css": [".title", ".site"],
  "blocks/WorkActivityBlock/WorkActivityBlock.module.css": [".compact .marker, .compact .icon, .compact .toolIcon"],
  "blocks/MetricCard/MetricCard.module.css": [".change"],
  "blocks/TagField/TagField.module.css": [".option", ".count"],
  "blocks/NavRow/NavRow.module.css": [".multiline .icon", ".multiline .icon:not([data-viewport=\"desktop\"], [data-viewport=\"desktop\"] *)"],
  "blocks/MarkdownContent/MarkdownContent.module.css": [".markdown h4, .markdown h5, .markdown h6"],
  "blocks/ListRow/ListRow.module.css": [".meta"],
  "blocks/KeyValueRow/KeyValueRow.module.css": [".valueBody"],
  "components/DropdownMenu/DropdownMenu.module.css": [".shortcut"],
  "components/Field/Field.module.css": [".title", ".separator"],
  "components/Popover/Popover.module.css": [".header"],
  "components/Select/Select.module.css": [".label"],
  "components/Breadcrumb/Breadcrumb.module.css": [".list"],
  "viewer/DesignSystemViewer.module.css": [".heroTitle"],
  "viewer/foundations/Foundations.module.css": [
    ".chapterTitle:not([data-viewport=\"desktop\"], [data-viewport=\"desktop\"] *), .voiceLine:not([data-viewport=\"desktop\"], [data-viewport=\"desktop\"] *)",
    ".roleInk:not([data-viewport=\"desktop\"], [data-viewport=\"desktop\"] *)",
  ],
};

function unpairedFontSizeFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  const normalized = path.replaceAll("\\", "/");
  if (RATIO_ALLOWED.test(normalized)) return [];
  const match = FONT_SIZE_TOKEN.exec(rule.body);
  if (!match || LINE_HEIGHT_SET.test(rule.body)) return [];
  const selector = rule.selector.replace(/\s+/gu, " ");
  const ratchet = Object.entries(UNPAIRED_FONT_SIZE_RATCHET).some(([file, selectors]) =>
    normalized.endsWith(`libs/design-system/${file}`) && selectors.includes(selector));
  if (ratchet) return [];
  return [{ path, line: rule.line, reason: `font-size var(${match[1]}) needs its --typo-*-line-height token in the same rule`, text: selector }];
}

export function lintDesignSystemRules(path: string, source: string): DesignSystemRuleFinding[] {
  return cssRules(source).flatMap((rule) => [
    ...ratioLineHeightFindings(path, rule),
    ...unpairedFontSizeFindings(path, rule),
    ...focusRingFindings(path, rule),
    ...zIndexFindings(path, rule),
    ...rawHeightFindings(path, rule),
    ...rawMotionFindings(path, rule),
    ...rawScaleFindings(path, rule, "spacing"),
    ...rawScaleFindings(path, rule, "radius"),
    ...unscaledRadiusFindings(path, rule),
  ]);
}

/** Cards and list items show their glyph bare: no IconTile inside the card blocks or passed as their icon. */
const CARD_BLOCK = /libs\/design-system\/blocks\/(ChoiceCard|CheckCard|ListRow)\/[^/]+(?<!\.guidance)\.tsx$/;
const TILE_AS_CARD_ICON = /<(ChoiceCard|ChoiceTile|CheckCard|ListRow)\b[^>]*?\bicon=\{\s*<IconTile\b/gs;

export function lintCardIcons(path: string, source: string): DesignSystemRuleFinding[] {
  const findings: DesignSystemRuleFinding[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  if (CARD_BLOCK.test(path.replaceAll("\\", "/")) && /\bIconTile\b/.test(source)) {
    findings.push({ path, line: lineOf(source.search(/\bIconTile\b/)), reason: "card blocks show their glyph bare; no IconTile", text: "IconTile" });
  }
  for (const match of source.matchAll(TILE_AS_CARD_ICON)) {
    findings.push({ path, line: lineOf(match.index ?? 0), reason: `no IconTile behind a ${match[1]} icon; pass the glyph alone`, text: `<${match[1]} icon={<IconTile` });
  }
  return findings;
}

function walk(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "dist" || entry === "node_modules") return [];
    if (statSync(path).isDirectory()) return walk(path, extension);
    return entry.endsWith(extension) ? [path] : [];
  });
}

const walkCss = (dir: string) => walk(dir, ".css");

if (import.meta.main) {
  const root = process.cwd();
  const sourceRoot = join(root, "packages", "butler-app", "client", "ui", "src");
  const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
    !process.argv.includes("--silent");
  const files = walkCss(sourceRoot);
  const findings = [
    ...files.flatMap((path) => lintDesignSystemRules(relative(root, path), readFileSync(path, "utf8"))),
    ...walk(sourceRoot, ".tsx").flatMap((path) => lintCardIcons(relative(root, path), readFileSync(path, "utf8"))),
  ];
  if (findings.length > 0) {
    console.error("Design-system rules lint failed:");
    for (const finding of findings) {
      console.error(`${finding.path}:${finding.line}: ${finding.reason}`);
      console.error(`  ${finding.text}`);
    }
    process.exit(1);
  }
  if (verbose) console.log(`Design-system rules lint passed for ${files.length} CSS files.`);
}
