import { smokeBrowserArgs } from "../support/smoke-browser.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

const root = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "butler-design-system-smoke-"));
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function openViewerPage(page: Page, baseUrl: string, pageId: string): Promise<void> {
  await page.goto(`${baseUrl}?visual=design-system&page=${encodeURIComponent(pageId)}`, {
    waitUntil: "networkidle",
  });
  await page.locator(`[data-ds-page="${pageId}"]`).waitFor({ state: "attached" });
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 1, `${label}: viewer has horizontal overflow of ${overflow}px`);
}

async function assertWorkbench(page: Page, baseUrl: string, label: string): Promise<void> {
  await openViewerPage(page, baseUrl, "foundations");
  await page.locator('[data-ds-foundations="index"] [data-ds-token-category]').first().waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, `${label} foundations index`);
  // Chapters are guidebook specimens first; the raw table (generated from tokens.css) is one click away.
  await openViewerPage(page, baseUrl, "foundations/color");
  await page.locator('[data-ds-foundations="color"] [data-ds-guide-section="roles"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll('[data-ds-foundations="color"] [data-ds-specimen^="role-"] [data-ds-theme]').length >= 20
    && [...document.querySelectorAll('[data-ds-specimen^="role-"]')].every((card) => /\d\.\d:1/u.test(card.textContent ?? "")));
  assert(await page.locator("[data-ds-token-name]").count() === 0, `${label}: the token table should start collapsed`);
  await page.locator('[data-ds-foundations="color"] [data-ds-all-tokens-toggle]').click();
  await page.locator('[data-ds-foundations="color"] [data-ds-token-name]').first().waitFor({ state: "visible" });
  const tokenInventory = await page.evaluate(() => {
    const names = Array.from(
      document.querySelectorAll<HTMLElement>("[data-ds-token-name]"),
      (element) => element.dataset.dsTokenName,
    );
    return {
      total: names.length,
      colorTotal: document.querySelectorAll('[data-ds-token-kind="color"]').length,
      hasRawPalette: names.includes("--grayscale-01") && names.includes("--amber-10"),
      hasSemantic: names.includes("--color-text-primary") && names.includes("--color-focus-ring"),
      hasAppAlias: names.includes("--conversation-bg") && names.includes("--placeholder"),
      hasContext: names.includes("--context-chart-6") && names.includes("--context-chart-free"),
    };
  });
  assert(tokenInventory.total >= 120, `${label}: token inventory is too sparse`);
  assert(tokenInventory.colorTotal >= 110, `${label}: color tokens are not fully listed`);
  assert(tokenInventory.hasRawPalette, `${label}: raw palette color tokens are missing`);
  assert(tokenInventory.hasSemantic, `${label}: semantic color tokens are missing`);
  assert(tokenInventory.hasAppAlias, `${label}: app alias color tokens are missing`);
  assert(tokenInventory.hasContext, `${label}: context color tokens are missing`);
  await assertNoHorizontalOverflow(page, `${label} foundations`);
  await openViewerPage(page, baseUrl, "foundations/typography");
  const ladder = await page.locator("[data-ds-type-ladder]").getAttribute("data-ds-type-ladder");
  const rungs = await page.locator("[data-ds-type-role]").count();
  assert(Number(ladder) >= 17 && rungs === Number(ladder), `${label}: type ladder should render every --typo-* role (${rungs}/${ladder})`);
  await assertNoHorizontalOverflow(page, `${label} typography`);
  await openViewerPage(page, baseUrl, "blocks");
  const blockCount = await page.locator("[data-ds-component]").count();
  await assertNoHorizontalOverflow(page, `${label} blocks`);
  await openViewerPage(page, baseUrl, "components");
  const primitiveCount = await page.locator("[data-ds-component]").count();
  const itemCount = primitiveCount + blockCount;
  assert(itemCount >= 60, `${label}: expected primitive and expanded block fixtures to render`);
  await assertNoHorizontalOverflow(page, `${label} components`);

  const visualState = await page.evaluate(() => {
    const rectOf = (element: Element | null) =>
      element?.getBoundingClientRect().toJSON() ?? null;
    const chart = document.querySelector('[data-ds-component="Chart"] [data-slot="chart"]');
    const chartSvg = chart?.querySelector("svg") ?? null;
    const nativeSelect = document.querySelector('[data-ds-component="NativeSelect"]');
    const nativeCanvas = nativeSelect?.querySelector("[data-ds-fixture-canvas]") ?? null;
    const nativeWrapper = nativeSelect?.querySelector('[data-slot="native-select-wrapper"]') ?? null;
    const nativeTrigger = nativeSelect?.querySelector('[data-slot="native-select-trigger"]') ?? null;
    const nativeIcon = nativeSelect?.querySelector('[data-slot="native-select-icon"]') ?? null;
    const input = document.querySelector('[data-ds-component="Input"] [data-slot="input"]') as HTMLInputElement | null;
    const inputPlaceholder = document.querySelector('[data-ds-component="Input"] [aria-label="Placeholder input"]') as HTMLInputElement | null;
    const textarea = document.querySelector('[data-ds-component="Textarea"] [data-slot="textarea"]') as HTMLTextAreaElement | null;
    const selectTrigger = document.querySelector('[data-ds-component="Select"] [data-slot="select-trigger"]');
    const clickableFixture = document.querySelector('[data-ds-component="Clickable"] [data-ds-fixture-canvas]')?.parentElement ?? null;
    const clickable = clickableFixture?.querySelector('[data-slot="clickable"]') ?? null;
    const pillCanvas = document.querySelector('[data-ds-component="PillButton"] [data-ds-fixture-canvas]');
    const pillButton = pillCanvas?.querySelector('[data-slot="button"]') ?? null;
    const separatorLine = document.querySelector(
      '[data-ds-component="Separator"] [data-slot="separator"][data-line="true"]',
    );
    const tabsList = document.querySelector('[data-ds-component="Tabs"] [data-slot="tabs-list"]');
    const tabsTrigger = document.querySelector('[data-ds-component="Tabs"] [data-slot="tabs-trigger"]');
    const tabsTriggerStyle = tabsTrigger ? getComputedStyle(tabsTrigger) : null;
    const fixture = document.querySelector('[data-ds-component="Tabs"] [data-ds-fixture-canvas]')?.parentElement ?? null;
    const fixtureCanvas = document.querySelector('[data-ds-component="Tabs"] [data-ds-fixture-canvas]');
    const chartRect = rectOf(chart);
    const chartSvgRect = rectOf(chartSvg);
    const triggerRect = rectOf(nativeTrigger);
    const nativeCanvasRect = rectOf(nativeCanvas);
    const nativeWrapperRect = rectOf(nativeWrapper);
    const iconRect = rectOf(nativeIcon);
    const rootTextColor = getComputedStyle(document.body).color;
    const inputStyle = input ? getComputedStyle(input) : null;
    const inputPlaceholderStyle = inputPlaceholder ? getComputedStyle(inputPlaceholder, "::placeholder") : null;
    const textareaStyle = textarea ? getComputedStyle(textarea) : null;
    const selectTriggerStyle = selectTrigger ? getComputedStyle(selectTrigger) : null;
    const nativeTriggerStyle = nativeTrigger ? getComputedStyle(nativeTrigger) : null;
    const clickableFixtureRect = rectOf(clickableFixture);
    const clickableRect = rectOf(clickable);
    const pillCanvasRect = rectOf(pillCanvas);
    const pillButtonRect = rectOf(pillButton);
    const separatorBefore = separatorLine
      ? getComputedStyle(separatorLine, "::before")
      : null;
    const tabsListRect = rectOf(tabsList);
    const tabsFixtureRect = rectOf(fixture);
    const fixtureCanvasRect = rectOf(fixtureCanvas);

    return {
      chartVisible:
        Boolean(chartRect && chartSvgRect) &&
        chartRect!.width > 0 &&
        chartRect!.height > 0 &&
        chartSvgRect!.width > 0 &&
        chartSvgRect!.height > 0,
      nativeIconInside:
        Boolean(triggerRect && iconRect) &&
        iconRect!.left >= triggerRect!.left &&
        iconRect!.right <= triggerRect!.right &&
        iconRect!.top >= triggerRect!.top &&
        iconRect!.bottom <= triggerRect!.bottom,
      clickableCentered:
        Boolean(clickableFixtureRect && clickableRect) &&
        Math.abs(
          clickableFixtureRect!.top +
            clickableFixtureRect!.height / 2 -
            (clickableRect!.top + clickableRect!.height / 2),
        ) <= 1,
      clickableIntrinsicWidth:
        Boolean(clickableFixtureRect && clickableRect) &&
        clickableRect!.width < clickableFixtureRect!.width - 8,
      pillIntrinsicWidth:
        Boolean(pillCanvasRect && pillButtonRect) &&
        pillButtonRect!.width < pillCanvasRect!.width - 8,
      nativeSelectIntrinsicWidth:
        Boolean(nativeCanvasRect && nativeWrapperRect) &&
        nativeWrapperRect!.width < nativeCanvasRect!.width - 8,
      inputValuesUseDefaultColor:
        Boolean(inputStyle && textareaStyle && selectTriggerStyle && nativeTriggerStyle) &&
        inputStyle!.color === rootTextColor &&
        textareaStyle!.color === rootTextColor &&
        selectTriggerStyle!.color === rootTextColor &&
        nativeTriggerStyle!.color === rootTextColor,
      placeholderIsMuted:
        Boolean(inputPlaceholderStyle && inputStyle) &&
        inputPlaceholderStyle!.color !== inputStyle!.color,
      separatorHasLine:
        Boolean(separatorBefore) &&
        separatorBefore!.content !== "none" &&
        separatorBefore!.height === "1px",
      tabsStyled:
        Boolean(tabsListRect && tabsTriggerStyle) &&
        tabsListRect!.height >= 30 &&
        tabsTriggerStyle!.borderRadius !== "0px" &&
        tabsTriggerStyle!.transitionDuration !== "0s",
      fixtureCanvasStretches:
        Boolean(tabsFixtureRect && fixtureCanvasRect) &&
        fixtureCanvasRect!.width >= tabsFixtureRect!.width - 28,
    };
  });

  assert(visualState.chartVisible, `${label}: chart fixture is not visible`);
  assert(visualState.nativeIconInside, `${label}: native select icon escaped trigger`);
  assert(visualState.clickableCentered, `${label}: clickable fixture is not vertically centered`);
  assert(visualState.clickableIntrinsicWidth, `${label}: clickable fixture stretches without stretch prop`);
  assert(visualState.pillIntrinsicWidth, `${label}: pill button fixture stretches without stretch prop`);
  assert(visualState.nativeSelectIntrinsicWidth, `${label}: native select fixture stretches without stretch prop`);
  assert(visualState.inputValuesUseDefaultColor, `${label}: input values are not using the default text color`);
  assert(visualState.placeholderIsMuted, `${label}: input placeholder is not visually distinct from value text`);
  assert(visualState.separatorHasLine, `${label}: separator line fixture is not visible`);
  assert(visualState.tabsStyled, `${label}: tabs primitive is not Butler-styled`);
  assert(visualState.fixtureCanvasStretches, `${label}: fixture preview does not stretch with card width`);

  await openViewerPage(page, baseUrl, "blocks");
  const blocksVisible = await page.evaluate(() =>
    ["NavRow", "Notice", "DashboardHeader", "SettingsField", "ComposerControl"].every((name) =>
      Boolean(document.querySelector(`[data-ds-component="${name}"]`)?.getBoundingClientRect().height),
    ),
  );
  assert(blocksVisible, `${label}: block fixtures are not visible`);

  const formSectionState = await page.evaluate(() => {
    const section = document.querySelector('[data-ds-component="FormSection"] [data-slot="form-section"]');
    const header = section?.querySelector(':scope > [data-slot="form-section-header"]');
    const card = section?.querySelector(':scope > [data-slot="form-section-card"]');
    if (!section || !header || !card) return null;
    const headerBox = header.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return {
      gap: cardBox.top - headerBox.bottom,
      headerBorder: getComputedStyle(header).borderBottomWidth,
      headerBackground: getComputedStyle(header).backgroundColor,
      cardBorder: getComputedStyle(card).borderTopWidth,
      titleInCard: Boolean(card.querySelector(":scope > h3")),
    };
  });
  assert(
    formSectionState &&
      formSectionState.gap >= 8 &&
      formSectionState.gap <= 14 &&
      formSectionState.headerBorder === "0px" &&
      formSectionState.cardBorder === "1px" &&
      !formSectionState.titleInCard,
    `${label}: FormSection header should sit above its card, outside the surface: ${JSON.stringify(formSectionState)}`,
  );

  const navAndGroupState = await page.evaluate(() => {
    const navRow = document.querySelector('[data-ds-component="NavRow"] [data-slot="clickable"]');
    const activeNavRow = document.querySelector('[data-ds-component="NavRow"] [aria-current="page"]');
    const activeNavRowStyle = activeNavRow ? getComputedStyle(activeNavRow) : null;
    const controlRegion = document.querySelector('[data-ds-component="NavRow"] [class*="controlRegion"]');
    const controlledNavRow = controlRegion?.parentElement ?? null;
    const labelRegion = controlledNavRow?.querySelector('[class*="labelRegion"]') ?? null;
    const labelText = labelRegion?.querySelector('[class*="label"]') ?? null;
    const controlledNavRowStyle = controlledNavRow ? getComputedStyle(controlledNavRow) : null;
    const labelRect = labelRegion?.getBoundingClientRect().toJSON() ?? null;
    const controlRect = controlRegion?.getBoundingClientRect().toJSON() ?? null;
    const navRowStyle = navRow ? getComputedStyle(navRow) : null;
    const groupContent = document.querySelector('[data-ds-component="CollapsibleNavGroup"] [data-state="open"]');
    const groupHeader = document.querySelector('[data-ds-component="CollapsibleNavGroup"] [aria-expanded="true"]');
    const groupChild = groupContent?.querySelector('[data-slot="clickable"], [class*="row"]') ?? null;
    const groupHeaderRect = groupHeader?.getBoundingClientRect().toJSON() ?? null;
    const groupChildRect = groupChild?.getBoundingClientRect().toJSON() ?? null;
    const groupContentStyle = groupContent ? getComputedStyle(groupContent) : null;
    const groupItems = groupChild?.parentElement ?? null;
    const treeIndent = groupItems ? Number.parseFloat(getComputedStyle(groupItems).paddingInlineStart) : Number.NaN;

    return {
      navRowAnimated:
        Boolean(navRowStyle) &&
        navRowStyle!.transitionProperty.includes("background-color"),
      activeHasNoShadow:
        Boolean(activeNavRowStyle) &&
        activeNavRowStyle!.boxShadow === "none" &&
        activeNavRowStyle!.outlineStyle === "none",
      navRowTwoRegions:
        Boolean(controlledNavRowStyle && labelRect && controlRect && labelText) &&
        controlledNavRowStyle!.display === "grid" &&
        controlledNavRowStyle!.gridTemplateColumns.split(" ").length >= 2 &&
        labelRect!.left < controlRect!.left &&
        getComputedStyle(labelText!).textOverflow === "ellipsis",
      groupOpen: Boolean(groupContent),
      // The fixture opts into `indented` (tree mode): children inset by
      // --nav-tree-indent and keep the group row's right edge.
      groupChildrenTreeIndented:
        Boolean(groupHeaderRect && groupChildRect) &&
        treeIndent > 0 &&
        Math.abs(groupChildRect!.left - groupHeaderRect!.left - treeIndent) <= 1 &&
        Math.abs(groupHeaderRect!.right - groupChildRect!.right) <= 1,
      groupContentAnimated:
        Boolean(groupContentStyle) &&
        groupContentStyle!.transitionProperty.includes("height") &&
        groupContentStyle!.getPropertyValue("interpolate-size") === "allow-keywords",
      groupHasNoChevron: !document.querySelector(
        '[data-ds-component="CollapsibleNavGroup"] [class*="chevron"]',
      ),
    };
  });
  assert(navAndGroupState.navRowAnimated, `${label}: NavRow hover transition is missing`);
  assert(navAndGroupState.activeHasNoShadow, `${label}: NavRow active state has shadow or outline`);
  assert(navAndGroupState.navRowTwoRegions, `${label}: NavRow does not use label/control regions correctly`);
  assert(navAndGroupState.groupOpen, `${label}: CollapsibleNavGroup open state is not visible`);
  assert(navAndGroupState.groupChildrenTreeIndented, `${label}: CollapsibleNavGroup indented children are not inset by --nav-tree-indent`);
  assert(navAndGroupState.groupContentAnimated, `${label}: CollapsibleNavGroup content transition is missing`);
  assert(navAndGroupState.groupHasNoChevron, `${label}: CollapsibleNavGroup should not render a caret chevron`);

  const blockPolishState = await page.evaluate(() => {
    const rectOf = (element: Element | null) =>
      element?.getBoundingClientRect().toJSON() ?? null;
    const centerY = (rect: DOMRect | null) =>
      rect ? rect.top + rect.height / 2 : Number.NaN;
    const composerButton = document.querySelector(
      '[data-ds-component="ComposerControl"] [data-ds-fixture-canvas] [data-slot="button"]',
    );
    const activityIcon = document.querySelector(
      '[data-ds-component="ActivityFeed"] [data-ds-fixture-canvas] [data-slot="activity-feed-icon"]',
    );
    const activityTitle = document.querySelector(
      '[data-ds-component="ActivityFeed"] [data-ds-fixture-canvas] [data-slot="activity-feed-title"]',
    );
    const disclosureTrigger = document.querySelector(
      '[data-ds-component="DisclosureRow"] [data-slot="clickable"]',
    );
    const disclosureIcon = document.querySelector(
      '[data-ds-component="DisclosureRow"] [data-ds-fixture-canvas] [data-slot="disclosure-row-icon"]',
    );
    const disclosureTitle = document.querySelector(
      '[data-ds-component="DisclosureRow"] [data-ds-fixture-canvas] [data-slot="disclosure-row-title"]',
    );
    const titlebarLeading = document.querySelector(
      '[data-ds-component="TitlebarShell"] [data-ds-fixture-canvas] [data-slot="titlebar-leading"]',
    );
    const titlebarTitle = document.querySelector(
      '[data-ds-component="TitlebarShell"] [data-ds-fixture-canvas] [data-slot="titlebar-title"]',
    );
    const chromeSidebar = document.querySelector(
      '[data-ds-component="ChromeFrame"] [data-ds-fixture-canvas] [data-slot="chrome-frame-sidebar"]',
    );
    const chromeMain = document.querySelector(
      '[data-ds-component="ChromeFrame"] [data-ds-fixture-canvas] [data-slot="chrome-frame-main"]',
    );
    const workerIcon = document.querySelector(
      '[data-ds-component="WorkerActivityRow"] [data-ds-fixture-canvas] [data-slot="activity-feed-icon"]',
    );
    const workerTitle = document.querySelector(
      '[data-ds-component="WorkerActivityRow"] [data-ds-fixture-canvas] [data-slot="activity-feed-title"]',
    );
    const automationIcon = document.querySelector(
      '[data-ds-component="AutomationRunList"] [data-ds-fixture-canvas] [data-slot="activity-feed-icon"]',
    );
    const automationTitle = document.querySelector(
      '[data-ds-component="AutomationRunList"] [data-ds-fixture-canvas] [data-slot="activity-feed-title"]',
    );

    const composerRect = rectOf(composerButton);
    const activityIconRect = rectOf(activityIcon);
    const activityTitleRect = rectOf(activityTitle);
    const disclosureIconRect = rectOf(disclosureIcon);
    const disclosureTitleRect = rectOf(disclosureTitle);
    const titlebarLeadingRect = rectOf(titlebarLeading);
    const titlebarTitleRect = rectOf(titlebarTitle);
    const workerIconRect = rectOf(workerIcon);
    const workerTitleRect = rectOf(workerTitle);
    const automationIconRect = rectOf(automationIcon);
    const automationTitleRect = rectOf(automationTitle);
    const disclosureStyle = disclosureTrigger ? getComputedStyle(disclosureTrigger) : null;
    const sidebarStyle = chromeSidebar ? getComputedStyle(chromeSidebar) : null;
    const mainStyle = chromeMain ? getComputedStyle(chromeMain) : null;

    // Touch widths keep the visual pill height and extend only the hit area.
    const composerHitTargetMet = (() => {
      if (!composerButton) return false;
      composerButton.scrollIntoView({ block: "center", inline: "center" });
      const rect = composerButton.getBoundingClientRect();
      const minTarget = window.innerWidth <= 640 ? 44 : rect.height;
      const x = rect.left + rect.width / 2;
      const reach = (minTarget - rect.height) / 2 - 0.5;
      return [rect.top - reach, rect.bottom + reach].every(
        (y) => document.elementFromPoint(x, y)?.closest('[data-slot="button"]') === composerButton,
      );
    })();

    return {
      composerHitTargetMet,
      composerKeepsButtonHeight:
        Boolean(composerRect) && composerRect!.height >= 24 && composerRect!.height <= 34,
      activityIconTitleAligned:
        Boolean(activityIconRect && activityTitleRect) &&
        Math.abs(centerY(activityIconRect) - centerY(activityTitleRect)) <= 2,
      disclosureGridStable:
        Boolean(disclosureStyle) &&
        disclosureStyle!.display === "grid" &&
        disclosureStyle!.gridTemplateColumns.split(" ").length >= 2,
      disclosureIconTitleAligned:
        Boolean(disclosureIconRect && disclosureTitleRect) &&
        Math.abs(centerY(disclosureIconRect) - centerY(disclosureTitleRect)) <= 2,
      titlebarLeadingTitleAligned:
        Boolean(titlebarLeadingRect && titlebarTitleRect) &&
        Math.abs(centerY(titlebarLeadingRect) - centerY(titlebarTitleRect)) <= 2,
      chromeBorderJoinSingle:
        Boolean(sidebarStyle && mainStyle) &&
        sidebarStyle!.borderRightWidth === "0px" &&
        (sidebarStyle!.display === "none"
          ? mainStyle!.borderLeftWidth === "0px"
          : mainStyle!.borderLeftWidth === "1px"),
      workerIconTitleAligned:
        Boolean(workerIconRect && workerTitleRect) &&
        Math.abs(centerY(workerIconRect) - centerY(workerTitleRect)) <= 2,
      automationIconTitleAligned:
        Boolean(automationIconRect && automationTitleRect) &&
        Math.abs(centerY(automationIconRect) - centerY(automationTitleRect)) <= 2,
    };
  });
  assert(blockPolishState.composerKeepsButtonHeight, `${label}: ComposerControl button is stretching vertically`);
  assert(blockPolishState.composerHitTargetMet, `${label}: ComposerControl hit target is below 44px on touch widths`);
  assert(blockPolishState.activityIconTitleAligned, `${label}: ActivityFeed icon/title alignment is off`);
  assert(blockPolishState.disclosureGridStable, `${label}: DisclosureRow trigger layout is unstable`);
  assert(blockPolishState.disclosureIconTitleAligned, `${label}: DisclosureRow icon/title alignment is off`);
  assert(blockPolishState.titlebarLeadingTitleAligned, `${label}: TitlebarShell leading/title alignment is off`);
  assert(blockPolishState.chromeBorderJoinSingle, `${label}: ChromeFrame adjacent borders are doubled`);
  assert(blockPolishState.workerIconTitleAligned, `${label}: WorkerActivityRow icon/title alignment is off`);
  assert(blockPolishState.automationIconTitleAligned, `${label}: AutomationRunList icon/title alignment is off`);

  const groupHeader = page.locator('[data-ds-component="CollapsibleNavGroup"]').getByRole("button", { name: "Design system" });
  await groupHeader.click();
  await page.waitForFunction(() =>
    document.querySelector('[data-ds-component="CollapsibleNavGroup"] [aria-expanded="false"]'),
  );
  await groupHeader.click();
  await page.waitForFunction(() =>
    document.querySelector('[data-ds-component="CollapsibleNavGroup"] [aria-expanded="true"]'),
  );

  await page.locator('[data-ds-component="DashboardHeader"]').getByRole("button", { name: "Open details" }).click();
  await page.locator('[data-ds-detail="DashboardHeader"]').waitFor({ state: "visible" });
  await page.getByText("Guidance", { exact: true }).first().waitFor({ state: "visible" });
  await page.locator('[data-ds-detail="DashboardHeader"] [data-ds-story] [data-ds-fixture-canvas]').first().waitFor({ state: "visible" });
  const detailUrl = new URL(page.url());
  assert(detailUrl.searchParams.get("page") === "blocks/DashboardHeader", `${label}: Open details did not deep-link the item page`);

  await assertItemGuidanceAndStates(page, baseUrl, label);
}

async function assertItemGuidanceAndStates(page: Page, baseUrl: string, label: string): Promise<void> {
  await openViewerPage(page, baseUrl, "components/Button");
  const matrix = page.locator('[data-ds-detail="Button"] [data-ds-states-matrix]').first();
  await matrix.waitFor({ state: "visible" });
  const states = await page.evaluate(() => {
    const cell = (id: string) => document.querySelector(`[data-ds-state-cell="${id}"] [data-slot="button"]`);
    const style = (id: string) => {
      const element = cell(id);
      return element ? getComputedStyle(element) : null;
    };
    const base = style("default:default");
    const hover = style("default:hover");
    const focus = style("default:focus-visible");
    return {
      forcedLayer: Boolean(document.querySelector("style[data-ds-force-state-layer]")),
      hoverDiffers: Boolean(base && hover) && base!.backgroundColor !== hover!.backgroundColor,
      focusRing: Boolean(focus) && (focus!.outlineStyle !== "none" || focus!.boxShadow !== "none"),
      disabled: (cell("default:disabled") as HTMLButtonElement | null)?.disabled === true,
      guidance: ["usage", "do-dont", "recipes", "notes", "tokens"]
        .every((section) => Boolean(document.querySelector(`[data-ds-detail="Button"] [data-ds-guidance="${section}"]`))),
      recipes: document.querySelectorAll('[data-ds-detail="Button"] [data-ds-recipe]').length,
    };
  });
  assert(states.forcedLayer, `${label}: the forced-state stylesheet is missing`);
  assert(states.hoverDiffers, `${label}: forced hover does not change the Button fill`);
  assert(states.focusRing, `${label}: forced focus-visible does not draw the focus ring`);
  assert(states.disabled, `${label}: the disabled state cell is not a disabled Button`);
  assert(states.guidance, `${label}: Button guidance sections are incomplete`);
  assert(states.recipes >= 1, `${label}: Button has no composition recipe`);
  await assertNoHorizontalOverflow(page, `${label} Button item`);
}

assert(
  existsSync(join(uiRoot, "index.html")),
  "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first.",
);

const server = await createNativeAppServer({ uiRoot });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });

try {
  for (const viewport of [
    { label: "mobile-320", width: 320, height: 740 },
    { label: "mobile-375", width: 375, height: 812 },
    { label: "mobile-390", width: 390, height: 844 },
    { label: "mobile-430", width: 430, height: 932 },
    { label: "desktop", width: 1280, height: 900 },
  ]) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    await server.signIn(page);
    await assertWorkbench(page, server.url, viewport.label);
    await page.close();
  }
  console.log("app-design-system-smoke: ok");
} finally {
  await browser.close();
  await server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
