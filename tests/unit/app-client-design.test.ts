import { expect, test, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoOrLedgerPath } from "../support/project-ledger-root.ts";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(resolveRepoOrLedgerPath(path), "utf8");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ");
}

function readUiSources(dir = "packages/butler-app/client/ui/src"): string {
  const absolute = join(root, dir);
  return readdirSync(absolute)
    .flatMap((entry) => {
      const path = join(absolute, entry);
      const relative = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) return readUiSources(relative);
      if (!/\.(?:js|jsx|ts|tsx|css)$/u.test(entry)) return "";
      return readFileSync(path, "utf8");
    })
    .join("\n");
}

function readUiStyleSources(dir = "packages/butler-app/client/ui/src"): string {
  const absolute = join(root, dir);
  return readdirSync(absolute)
    .flatMap((entry) => {
      const path = join(absolute, entry);
      const relative = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) return readUiStyleSources(relative);
      if (!/\.module\.css$/u.test(entry)) return "";
      return readFileSync(path, "utf8");
    })
    .join("\n");
}

function listUiSourceFiles(
  dir = "packages/butler-app/client/ui/src",
): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const path = join(absolute, entry);
    const relative = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) return listUiSourceFiles(relative);
    return [relative];
  });
}

test("dedicated client design foundation uses React and Hugeicons", () => {
  const rootPackage = JSON.parse(read("package.json"));
  const packageJson = JSON.parse(
    read("packages/butler-app/client/ui/package.json"),
  );
  const main = read("packages/butler-app/client/ui/src/main.tsx");
  const renderer = readUiSources();
  const uiSources = listUiSourceFiles();
  const icons = read(
    "packages/butler-app/client/ui/src/libs/design-system/components/Icons/Icons.tsx",
  );

  expect(packageJson.dependencies).toHaveProperty("react");
  expect(packageJson.dependencies).toHaveProperty("react-dom");
  expect(packageJson.dependencies).not.toHaveProperty("lucide-react");
  expect(packageJson.dependencies).toHaveProperty("@hugeicons/react");
  expect(packageJson.dependencies).toHaveProperty("@hugeicons/core-free-icons");
  expect(packageJson.dependencies).toHaveProperty("@tanstack/react-virtual");
  expect(packageJson.dependencies).toHaveProperty("zustand");
  expect(packageJson.dependencies).toHaveProperty("sonner");
  expect(packageJson.dependencies).toHaveProperty("react-markdown");
  expect(packageJson.dependencies).toHaveProperty("remark-gfm");
  expect(packageJson.scripts.typecheck).toContain(
    "tsc -p tsconfig.json --noEmit",
  );
  expect(rootPackage.scripts.typecheck).toContain(
    "npm --prefix packages/butler-app/client/ui run --silent typecheck",
  );
  expect(rootPackage.devDependencies).toHaveProperty("prettier");
  expect(rootPackage.devDependencies).toHaveProperty("stylelint");
  expect(rootPackage.devDependencies).toHaveProperty(
    "stylelint-config-standard",
  );
  expect(rootPackage.scripts.lint).toContain("lint:css");
  expect(rootPackage.scripts.lint).toContain("lint:design");
  expect(rootPackage.scripts["lint:css"]).toContain("format:css:check");
  expect(rootPackage.scripts["lint:css"]).toContain("stylelint");
  expect(rootPackage.scripts.format).toContain("format:css");
  expect(rootPackage.scripts["format:css"]).toContain("prettier --write");
  expect(rootPackage.scripts["format:css:check"]).toContain("prettier --check");
  expect(rootPackage.scripts["app:client:dev"]).toContain("app-client-dev.ts");
  expect(rootPackage.scripts["app:ui:hmr:smoke"]).toContain(
    "app-ui-hmr-smoke.ts",
  );
  expect(rootPackage.scripts["app:design-system:smoke"]).toContain(
    "app-design-system-smoke.ts",
  );
  expect(rootPackage.scripts["app:client:managed-server:smoke"]).toContain(
    "app-client-managed-server-smoke.ts",
  );
  expect(rootPackage.scripts["app:client:model-management:e2e"]).toContain(
    "app-model-management-e2e.ts",
  );
  expect(rootPackage.scripts["app:client:multiturn:e2e"]).toContain(
    "tests/e2e/app-client-multiturn-e2e.ts",
  );
  expect(rootPackage.scripts["app:client:btcc-opening-decision:e2e"]).toContain(
    "BUTLER_APP_CLIENT_E2E_MODE=btcc-opening-decision",
  );
  expect(rootPackage.scripts["app:client:btcc-opening-decision:live-llm:e2e"]).toContain(
    "BUTLER_APP_CLIENT_E2E_MODE=live-llm-btcc-opening-decision BUTLER_APP_CLIENT_E2E_MODEL=openai/gpt-5.5 BUTLER_APP_CLIENT_E2E_REASONING=medium",
  );
  expect(rootPackage.scripts["app:client:btcc-opening-decision:live-llm:glm-low:e2e"]).toContain(
    "BUTLER_APP_CLIENT_E2E_MODE=live-llm-btcc-opening-decision BUTLER_APP_CLIENT_E2E_MODEL=zai/glm-5.2 BUTLER_APP_CLIENT_E2E_REASONING=low",
  );
  const appClientMultiturnE2e = read("tests/e2e/app-client-multiturn-e2e.ts");
  expect(appClientMultiturnE2e).toContain("copyRegisteredHostedModelConfig");
  expect(appClientMultiturnE2e).toContain("readRegisteredHostedModelConfigs");
  expect(appClientMultiturnE2e).toContain("resolveProviderCredentialSecret");
  expect(rootPackage.scripts["app:client:multiturn:live-llm:e2e"]).toContain(
    "BUTLER_APP_CLIENT_E2E_MODE=live-llm",
  );
  expect(rootPackage.scripts["app:client:toolchain:e2e"]).toContain(
    "BUTLER_APP_CLIENT_E2E_MODE=toolchain",
  );
  expect(rootPackage.scripts["app:client:toolchain:live-llm:e2e"]).toContain(
    "BUTLER_APP_CLIENT_E2E_MODE=live-llm-toolchain",
  );
  expect(read("stylelint.config.mjs")).toContain("stylelint-config-standard");
  expect(read("stylelint.config.mjs")).toContain(
    'ignorePseudoClasses: ["global"]',
  );
  expect(read("packages/butler-app/client/ui/tsconfig.json")).toContain(
    '"jsx": "react-jsx"',
  );
  expect(read("packages/butler-app/client/ui/tsconfig.json")).toContain(
    '"strict": true',
  );
  expect(read("packages/butler-app/client/ui/tsconfig.json")).toContain(
    '"noImplicitAny": true',
  );
  expect(uiSources.filter((file) => /\.(?:js|jsx)$/u.test(file))).toEqual([]);
  expect(main.split("\n").length).toBeLessThanOrEqual(40);
  expect(renderer).not.toContain('from "lucide-react"');
  expect(renderer).toContain('from "@hugeicons/react"');
  expect(renderer).toContain('from "@hugeicons/core-free-icons"');
  expect(renderer).toContain("function createIcon");
  expect(renderer).toContain("@/butler-ds");
  expect(renderer).toContain('from "@tanstack/react-virtual"');
  expect(renderer).toContain('from "zustand"');
  expect(renderer).toContain(".module.css");
  expect(renderer).toContain("function Titlebar");
  expect(renderer).toContain("function Sidebar");
  expect(renderer).toContain("function VisualHarness");
  expect(renderer).toContain("class ErrorBoundary");
  expect(main).toContain("<ErrorBoundary>");
  expect(renderer).toContain("PanelLeft");
  expect(renderer).toContain("PanelLeftOpen");
  expect(renderer).toContain("PanelRight");
  expect(renderer).toContain("PanelRightClose");
  expect(renderer).toContain("MoreHorizontal");
  expect(icons).toContain('export const Folder = createIcon("Folder01Icon")');
  expect(icons).toContain(
    'export const FolderOpen = createIcon("Folder02Icon")',
  );
  expect(icons).toContain('export const Expand = createIcon("ExpandIcon")');
  expect(icons).toContain('export const Collapse = createIcon("CollapseIcon")');
  expect(icons).toContain(
    'export const PanelLeft = createIcon("PanelLeftIcon")',
  );
  expect(icons).toContain(
    'export const PanelLeftOpen = createIcon("PanelLeftOpenIcon")',
  );
  expect(icons).toContain(
    'export const PanelRight = createIcon("PanelRightIcon")',
  );
  expect(icons).toContain(
    'export const PanelRightClose = createIcon("PanelRightCloseIcon")',
  );
});

test("dedicated client design tokens cover flat sidebar and custom titlebar primitives", () => {
  const css = read(
    "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
  );
  const componentCss = readUiStyleSources();

  expect(css).toContain("--sidebar-bg: rgba(255, 255, 255, 0.52);");
  expect(css).toContain("--sidebar-collapsed-bg: rgba(244, 245, 247, 0.18);");
  expect(css).toContain("--font-size-3: 14px");
  expect(css).toContain("--composer-reserve");
  expect(css).toContain("--composer-glass-bg");
  expect(css).toContain("--composer-glass-control-bg");
  expect(css).toContain("--composer-glass-border: rgba(255, 255, 255, 0.65);");
  expect(css).toContain("--composer-glass-border: rgba(0, 0, 0, 0.08);");
  expect(css).toContain("--composer-glass-glint: transparent;");
  expect(css).toContain("--composer-glass-filter");
  expect(css).not.toContain(".liquid-glass-popover,");
  expect(css).not.toContain('[data-glass="popover"]');
  expect(css).not.toContain('[data-slot="context-menu-content"]');
  expect(css).not.toContain('[data-slot="context-menu-item"]');
  expect(componentCss).toContain("background: var(--composer-glass-bg)");
  expect(componentCss).toContain(
    "border: 1px solid var(--composer-glass-border)",
  );
  expect(componentCss).toContain(
    "backdrop-filter: var(--composer-glass-filter)",
  );
  expect(css).toContain("--titlebar-height: 48px");
  expect(css).toContain("--chrome-floating-toggle-top: 10px");
  expect(css).toContain("--chrome-floating-toggle-left: calc(");
  expect(css).toContain("-webkit-app-region: drag");
  expect(componentCss).toContain(":global(.mac-window)");
  expect(componentCss).toMatch(
    /:global\(\.mac-window\)\s*\{[\s\S]*background:\s*transparent;/,
  );
  expect(componentCss).toMatch(
    /:global\(\.mac-window\)\s*\{[\s\S]*color:\s*var\(--text-primary\);/,
  );
  expect(componentCss).toContain(".shell");
  expect(componentCss).toContain(".content");
  expect(componentCss).toContain(".header");
  expect(componentCss).toContain(".scrollFrame");
  expect(componentCss).toContain(".scroll");
  expect(componentCss).toContain(".scrollContent");
  expect(componentCss).toContain(".footer");
  expect(componentCss).toContain(".contentCollapsed");
  expect(componentCss).toContain(".collapsed");
  expect(componentCss).toContain(".contentCollapsed");
  expect(componentCss).toContain(".floatingLayer");
  expect(componentCss).toContain(".floatingToggle");
  expect(componentCss).toContain("top: var(--chrome-floating-toggle-top)");
  expect(componentCss).toContain("left: var(--chrome-floating-toggle-left)");
  expect(componentCss).toContain(":global(.panel-resize-handle)");
  expect(componentCss).toContain(":global(.left-panel-resize-handle)");
  expect(componentCss).toContain(":global(.right-panel-resize-handle)");
  expect(componentCss).toContain(".titlebar");
  expect(componentCss).toContain(".tabs");
  expect(componentCss).toContain(".button");
  expect(componentCss).toContain(".donut");
  expect(css).toContain("--workspace-bg");
  expect(css).toContain("--conversation-bg");
  expect(css).not.toContain("--sidebar-glass-bg");
  expect(css).not.toContain(".glass-sidebar");
  expect(css).not.toContain("--window-radius");
  expect(css).not.toContain("border-radius: var(--window-radius)");
  expect(css).not.toContain("box-shadow: var(--shadow-soft)");
  expect(css).not.toContain(".mac-window");
  expect(css).not.toContain(".app-sidebar");
  expect(css).not.toContain(".message.user");
  expect(css).not.toContain(".settings-view");
  expect(css).not.toContain(".command-palette");
});

test("dedicated client sidebar collapse keeps a normal clickable titlebar toggle", () => {
  const main = readUiSources();
  const css = readUiStyleSources();
  const tokens = read(
    "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
  );
  const chromeEnvironment = read(
    "packages/butler-app/client/ui/src/app/chromeEnvironment.ts",
  );
  const appShell = read("packages/butler-app/client/ui/src/pages/AppShell.tsx");
  const visualHarness = read(
    "packages/butler-app/client/ui/src/pages/VisualHarness.tsx",
  );

  expect(main).not.toContain("function ChromeControls");
  expect(main).not.toContain('className="chrome-controls"');
  expect(main).not.toContain("function CollapsedRail");
  expect(main).not.toContain("<CollapsedRail");
  expect(main).toContain("function WindowChromeLayer");
  expect(main).toContain("<WindowChromeLayer");
  expect(main).toContain("function Sidebar");
  expect(main).toContain("ChromeFloatingToggleLayer");
  expect(main).toContain("SidebarShell");
  expect(main).not.toContain("onToggleLeft");
  expect(main).toContain('data-test-class="app-sidebar"');
  expect(main).toContain("SidebarTrafficSpace");
  expect(tokens).toContain("--traffic-controls-width: 78px");
  expect(collapseWhitespace(tokens)).toContain(
    "--chrome-floating-toggle-left: calc( var(--traffic-controls-width) + var(--space-2) );",
  );
  expect(chromeEnvironment).toContain('return window.butlerApp ? "electron"');
  expect(chromeEnvironment).toContain('"electron-chrome"');
  expect(chromeEnvironment).toContain('"browser-chrome"');
  expect(appShell).toContain("chromeEnvironmentClassName()");
  expect(visualHarness).toContain("chromeEnvironmentClassName()");
  expect(tokens).toContain("--titlebar-height: 48px");
  expect(tokens).toContain("--chrome-floating-toggle-top: 10px");
  expect(tokens).toContain("--sidebar-width");
  expect(css).toContain(":global(.mac-window.left-collapsed)");
  expect(css).toContain(":global(.mac-window.panel-resizing)");
  expect(css).toContain(":global(.mac-window.browser-chrome)");
  expect(css).toContain("--traffic-controls-width: 0px");
  expect(css).toContain("--chrome-floating-toggle-left: 0px");
  expect(css).toContain(":global(.electron-chrome.platform-linux)");
  expect(collapseWhitespace(css)).toContain(
    "--titlebar-collapsed-left-padding: calc( var(--chrome-floating-toggle-left) + 44px )",
  );
  expect(css).toContain("--chrome-floating-toggle-left: 10px");
  expect(css).toMatch(
    /grid-template-columns:\s*minmax\(\s*0,\s*var\(--shell-left-column-target-width\)\s*\)\s*minmax\(\s*0,\s*1fr\s*\)\s*minmax\(\s*0,\s*var\(--shell-right-column-target-width\)\s*\);/,
  );
  expect(css).toContain("--shell-left-column-target-width: 0px");
  expect(css).toContain(
    "--shell-right-column-target-width: var(--shell-right-column-width)",
  );
  expect(css).toContain(":global(.left-collapsed .sidebar-slot)");
  expect(css).toContain(".contentCollapsed");
  expect(css).toContain("visibility: hidden");
  expect(main).toContain("Resize left sidebar");
  expect(main).toContain("Resize right panel");
  expect(main).toContain("selectRightAvailable");
  expect(main).toContain("rightAvailable && (");
  expect(main).toContain('data-test-class="right-panel-slot"');
  expect(main).toContain('<Inspector id="butler-right-inspector" />');
  expect(main).toContain("beginPanelResize");
  expect(main).toContain("handlePanelResizeKeyDown");
  expect(main).toContain("LEFT_PANEL_MIN_WIDTH");
  expect(main).toContain("aria-valuenow");
  expect(main).toContain('aria-controls="butler-left-sidebar"');
  expect(main).toContain('aria-controls="butler-right-inspector"');
  expect(main).toContain("tabIndex={0}");
  expect(main).toContain("setLeftOpen(false)");
  expect(main).toContain("--right-panel-width");
  expect(css).toContain(":global(.panel-resize-handle:focus-visible)");
  expect(css).toContain(":global(.right-panel-slot)");
  expect(css).toContain(
    'right-panel-slot [data-test-class~="right-inspector"]',
  );
  expect(css).toContain("width: var(--shell-right-column-width)");
  expect(css).toContain("contain: layout paint style");
  expect(css).toContain(".open");
  expect(css).toContain(".item");
  expect(css).toContain("-webkit-app-region: no-drag");
  expect(tokens).toContain(".drag-region input,");
  expect(tokens).toContain(".drag-region select,");
  expect(tokens).toContain('.drag-region [role="button"],');
  expect(tokens).toContain(".drag-region [tabindex]");
  expect(css).not.toContain(".chrome-controls {");
});

test("dedicated client keeps complete work history and session management controls visible", () => {
  const conversation = read(
    "packages/butler-app/client/ui/src/components/conversation/Conversation.tsx",
  );
  const sidebarChatsSection = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarChatsSection.tsx",
  );
  const sidebarProjectActions = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarProjectActions.tsx",
  );
  const sidebarProjectGroup = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarProjectGroup.tsx",
  );
  const sidebarProjectsMenu = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarProjectsMenu.tsx",
  );
  const sidebarProjectsSection = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarProjectsSection.tsx",
  );
  const sidebarSessionActions = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarSessionActions.tsx",
  );
  const sidebarChatItem = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarChatItem.tsx",
  );
  const sidebarProjectSessionItem = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarProjectSessionItem.tsx",
  );
  const useSidebarProjectCollapse = read(
    "packages/butler-app/client/ui/src/components/layout/useSidebarProjectCollapse.ts",
  );
  const sidebarComponentFiles = listUiSourceFiles(
    "packages/butler-app/client/ui/src/components/layout",
  ).filter((file) => /Sidebar.*\.(?:ts|tsx)$/u.test(file));
  const sidebarCss = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/SidebarShell/SidebarShell.module.css",
  );
  const titlebar = read(
    "packages/butler-app/client/ui/src/components/layout/Titlebar.tsx",
  );
  const copy = read("packages/butler-app/client/ui/src/app/copy.ts");

  expect(conversation).not.toContain(".slice(-3)");
  expect(sidebarCss).toContain(".scroll");
  expect(sidebarCss).toContain(".scrollFrame");
  expect(sidebarCss).toContain("--sidebar-scrollbar-offset: 10px");
  expect(sidebarCss).toContain("--sidebar-scroll-fade-size: 14px");
  expect(sidebarCss).toContain("--sidebar-scroll-edge-padding: 16px");
  expect(sidebarCss).toContain(
    "width: calc(100% + var(--sidebar-scrollbar-offset))",
  );
  expect(sidebarCss).toContain(
    "width: calc(100% - var(--sidebar-scrollbar-offset))",
  );
  expect(sidebarCss).toContain("max-width: 100%");
  expect(sidebarCss).toContain("min-width: 0");
  expect(sidebarCss).toContain("flex-direction: column");
  expect(sidebarCss).toContain("flex: 1 1 auto");
  expect(sidebarCss).toContain("overflow: hidden auto");
  expect(sidebarCss).toContain("scrollbar-width: thin");
  expect(sidebarCss).not.toContain("scrollbar-gutter: stable");
  expect(sidebarCss).not.toContain("padding-right: 12px");
  expect(sidebarCss).toContain("mask-image");
  expect(sidebarCss).toContain("mask-size");
  expect(sidebarCss).toContain(
    "padding-block: var(--sidebar-scroll-edge-padding)",
  );
  expect(sidebarCss).toContain("var(--sidebar-scrollbar-offset) 100%");
  expect(sidebarCss).not.toContain("margin-right: -");
  expect(
    read("packages/butler-app/client/ui/src/components/layout/Sidebar.tsx"),
  ).toContain("header={");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavSection/NavSection.tsx",
    ),
  ).toContain('gap="1"');
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavSection/NavSection.module.css",
    ),
  ).toContain("max-width: 100%");
  expect(
    read("packages/butler-app/client/ui/src/libs/design-system/tokens.css"),
  ).toContain("--sidebar-action-size: 24px");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/IconButton/IconButton.module.css",
    ),
  ).toContain("width: var(--icon-button-size, 30px)");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/RowActionCluster/RowActionCluster.module.css",
    ),
  ).toContain("--icon-button-size: var(--sidebar-action-size)");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavSection/NavSection.module.css",
    ),
  ).toContain("--icon-button-size: var(--sidebar-action-size)");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavRow/NavRow.module.css",
    ),
  ).toContain("--nav-row-action-target-size: var(--sidebar-action-size)");
  expect(sidebarCss).toContain(".footer");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavSection/NavSection.module.css",
    ),
  ).toContain(".contentCollapsed");
  expect(sidebarSessionActions).toContain("function SidebarSessionActions");
  expect(sidebarChatsSection).toContain("chatsCollapsed");
  expect(sidebarChatsSection).toContain("sidebarCopy.collapseChats");
  expect(sidebarChatsSection).toContain("sidebarCopy.expandChats");
  expect(sidebarProjectGroup).toContain(
    "effectiveCollapsed ? <Folder /> : <FolderOpen />",
  );
  expect(sidebarProjectsMenu).toContain("projectsCollapsed");
  expect(sidebarProjectsMenu).toContain("<Expand size={15} />");
  expect(sidebarProjectsMenu).toContain("<Collapse size={15} />");
  expect(sidebarChatsSection).toContain(
    "chatsCollapsed ? <Expand size={15} />",
  );
  expect(useSidebarProjectCollapse).toContain("Set<string>");
  expect(sidebarProjectsSection).toContain("collapsedProjectIds");
  expect(useSidebarProjectCollapse).toContain("setCollapsedProjectIds");
  expect(sidebarProjectActions).toContain("event.stopPropagation()");
  expect(sidebarProjectsSection).toContain(
    "collapsedProjectIds.has(project.id)",
  );
  expect(sidebarProjectsSection).toContain("projectRowCollapsed");
  expect(sidebarProjectActions).toContain('className="no-drag"');
  expect(sidebarSessionActions).toContain('className="no-drag"');
  expect(
    read("packages/butler-app/client/ui/src/components/layout/Chrome.tsx"),
  ).toContain(
    "leftOpen ? <PanelLeftOpen size={16} /> : <PanelLeft size={16} />",
  );
  expect(
    read("packages/butler-app/client/ui/src/components/layout/Titlebar.tsx"),
  ).toContain("rightOpen ? (");
  expect(
    read("packages/butler-app/client/ui/src/components/layout/Titlebar.tsx"),
  ).toContain("<PanelRightClose size={17} />");
  expect(
    read("packages/butler-app/client/ui/src/components/layout/Titlebar.tsx"),
  ).toContain('data-test-class="titlebar-right-panel-toggle"');
  expect(
    read("packages/butler-app/client/ui/src/components/layout/Titlebar.tsx"),
  ).not.toContain("selected={rightOpen}");
  expect(sidebarChatItem).toContain("runSessionAction");
  expect(sidebarProjectSessionItem).toContain("runSessionAction");
  expect(sidebarChatItem).toContain('rightVisibility="hover"');
  expect(sidebarProjectSessionItem).toContain('rightVisibility="hover"');
  expect(sidebarChatItem).toContain("onContextMenu");
  expect(sidebarProjectSessionItem).toContain("onContextMenu");
  expect(sidebarChatItem).toContain("event.preventDefault()");
  expect(sidebarProjectSessionItem).toContain("event.preventDefault()");
  expect(titlebar).toContain("sessionFromNavigation");
  expect(titlebar).toContain("runSessionAction(activeSession");
  expect(copy).toContain("sessionActions");
  for (const file of sidebarComponentFiles) {
    expect(read(file).split("\n").length).toBeLessThanOrEqual(160);
  }
});

test("theme and settings routes cover the full app surface", () => {
  const main = readUiSources();
  const css = readUiStyleSources();

  expect(main).toContain("selectIsSettingsView");
  expect(main).toContain("settings-active");
  expect(main).toContain("!isSettingsView && <WindowChromeLayer");
  expect(main).toContain("isSettingsView ? (");
  expect(css).toContain(":global(.mac-window.settings-active)");
  expect(css).toContain(".active");
  expect(css).toContain(".sidebarActive");
  expect(css).toMatch(
    /:global\(\.workspace\)\s*\{[\s\S]*background:\s*var\(--workspace-bg\);/,
  );
  expect(css).toMatch(
    /\.shell\s*\{[\s\S]*background:\s*var\(--conversation-bg\);/,
  );
  expect(css).toContain(".main-screen-theme-bloom");
  expect(css).toContain(".main-screen-theme-silk");
  expect(css).toMatch(
    /\.user \.body\s*\{[\s\S]*background:\s*var\(--user-message-bg\);/,
  );
  expect(css).toMatch(/\.user \.body\s*\{[\s\S]*border:\s*0;/);
  expect(css).toMatch(
    /\.feed\s*\{[\s\S]*padding:\s*var\(--space-xs\) var\(--space-sm\);/,
  );
  expect(css).toMatch(
    /\.item:hover\s*\{[\s\S]*background:\s*var\(--selection\);/,
  );
  expect(css).not.toMatch(
    /:global\(\.workspace\)\s*\{[\s\S]*background:\s*rgba\(255,\s*255,\s*255/,
  );
  expect(css).not.toMatch(
    /\.shell\s*\{[\s\S]*background:\s*linear-gradient\(180deg,\s*rgba\(255,\s*255,\s*255/,
  );
});

test("electron shell uses native macOS corners and sidebar vibrancy", () => {
  const electronMain = read("packages/butler-app/client/electron/main.mjs");

  expect(electronMain).toContain("width: 960");
  expect(electronMain).toContain("height: 710");
  expect(electronMain).toContain('const appDisplayName = "Butler"');
  expect(electronMain).toContain(
    'const appIconPath = resolve(__dirname, "assets/icon.png")',
  );
  expect(electronMain).toContain(
    'const macAppIconPath = resolve(__dirname, "assets/butler.icns")',
  );
  expect(electronMain).toContain(
    'const macAppDockIconPath = resolve(__dirname, "assets/butler-mac.png")',
  );
  expect(electronMain).toContain("app.setName(appDisplayName)");
  expect(electronMain).toContain("app.setAboutPanelOptions");
  expect(electronMain).toContain("applicationName: appDisplayName");
  expect(electronMain).toContain("configureAppIcon()");
  expect(electronMain).toContain("if (app.isPackaged) return;");
  expect(electronMain).toContain(
    "for (const iconPath of [macAppIconPath, appIconPath])",
  );
  expect(electronMain).not.toContain(
    "for (const iconPath of [macAppDockIconPath, macAppIconPath, appIconPath])",
  );
  expect(electronMain).toContain("app.dock.setIcon(iconPath)");
  expect(electronMain).toContain('titleBarStyle: "hidden"');
  expect(electronMain).toContain("icon: appIconForWindow()");
  expect(electronMain).toContain("minWidth: 320");
  expect(electronMain).toContain("minHeight: 480");
  expect(electronMain).toContain('const isMac = process.platform === "darwin"');
  expect(electronMain).toContain(
    "const macTrafficLightPosition = { x: 20, y: 18 }",
  );
  expect(electronMain).toContain('const macVibrancy = "sidebar"');
  expect(electronMain).toContain(
    "trafficLightPosition: macTrafficLightPosition",
  );
  expect(electronMain).toContain("frame: isLinux ? false : undefined");
  expect(electronMain).toContain("transparent: usesTransparentWindow");
  expect(electronMain).toContain("vibrancy: isMac ? macVibrancy : undefined");
  expect(electronMain).toContain("win.setVibrancy(macVibrancy)");
  expect(electronMain).toContain(
    "win.setBackgroundColor(macTransparentBackground)",
  );
  expect(electronMain).toContain("roundedCorners: true");
  expect(electronMain).toContain("Menu.setApplicationMenu(null)");
  expect(electronMain).toContain("autoHideMenuBar: true");
  expect(electronMain).toContain("win.setMenu(null)");
  expect(electronMain).toContain("win.setMenuBarVisibility(false)");
  expect(electronMain).toContain("isDevToolsAccelerator");
  expect(electronMain).toContain("before-input-event");
  expect(electronMain).toContain("devtools-opened");
  expect(electronMain).toContain("developerModeEnabled()");
  expect(electronMain).toContain("butler:set-developer-mode");
  expect(electronMain).toContain("butler:get-app-info");
  expect(electronMain).toContain(
    "developer_mode_enabled: developerModeEnabled()",
  );
});

test("fresh app chrome defaults to a collapsed left sidebar", () => {
  const store = read("packages/butler-app/client/ui/src/app/store.ts");
  const uiStateCache = read(
    "packages/butler-app/client/ui/src/app/appUiStateCache.ts",
  );
  const visualHarness = read(
    "packages/butler-app/client/ui/src/pages/VisualHarness.tsx",
  );

  expect(store).toContain("leftOpen: false");
  expect(uiStateCache).toContain("left_open: input.left_open ?? false");
  expect(visualHarness).toContain("setLeftOpen(false)");
  expect(store).toContain("leftOpen: uiState.left_open");
});

test("electron shell injects a minimal preload-only app API contract", () => {
  const electronMain = read("packages/butler-app/client/electron/main.mjs");
  const supervisor = read(
    "packages/butler-app/client/electron/app-agent-supervisor.mjs",
  );
  const preload = read("packages/butler-app/client/electron/preload.cjs");
  const viteConfig = read("packages/butler-app/client/ui/vite.config.ts");
  const renderer = readUiSources();

  expect(electronMain).toContain("const preloadPath");
  expect(electronMain).toContain("BUTLER_APP_UI_URL");
  expect(electronMain).toContain("rendererUrl");
  expect(electronMain).toContain("defaultRendererUrl");
  expect(electronMain).toContain("resolveStaticRendererUrl");
  expect(electronMain).toContain('join(process.resourcesPath, "app-client")');
  expect(electronMain).toContain("serverHealthUrl");
  expect(electronMain).toContain('new URL("/health", serverUrl).toString()');
  expect(electronMain).toContain("body?.protocol_version === appProtocolVersion");
  expect(electronMain).toContain("body?.data?.ok === true");
  expect(electronMain).toContain("createBundledAgentSupervisor");
  expect(electronMain).toContain("bundledAgentSupervisor.ensureReady()");
  expect(electronMain).toContain("butler:get-local-auth-headers");
  expect(electronMain).toContain("butler:ensure-server");
  expect(electronMain).toContain("butler:get-server-url");
  expect(electronMain).toContain("function appServerFetch");
  expect(electronMain).toContain("function appLocalAuthHeaders");
  expect(electronMain).toContain("normalizeLocalHttpUrl");
  expect(supervisor).toContain("BUTLER_APP_DEV_ORIGIN");
  expect(electronMain).toContain("await win.loadURL(rendererUrl)");
  expect(electronMain).toContain("handleFatalStartupError");
  expect(electronMain).toContain(".catch(handleFatalStartupError)");
  expect(electronMain).toContain("preload: preloadPath");
  expect(electronMain).toContain('resolve(__dirname, "preload.cjs")');
  expect(electronMain).toContain("contextIsolation: true");
  expect(electronMain).toContain("nodeIntegration: false");
  expect(electronMain).toContain("sandbox: true");
  expect(electronMain).toContain("setWindowOpenHandler");
  expect(electronMain).toContain("will-navigate");
  expect(electronMain).toContain("shell.openExternal");
  expect(electronMain).toContain("function openExternalUrl");
  expect(preload).toContain('require("electron")');
  expect(preload).not.toContain("import { contextBridge");
  expect(preload).toContain('contextBridge.exposeInMainWorld("butlerApp"');
  expect(preload).toContain("function normalizeLocalServerUrl");
  expect(preload).toContain(
    "Butler app server URL must be a local http origin.",
  );
  expect(preload).toContain('protocolVersion: "butler.app.v1"');
  expect(preload).toContain("getAppInfo:");
  expect(preload).toContain("setDeveloperMode:");
  expect(preload).toContain("butler:get-local-auth-headers");
  expect(preload).toContain("function ensureLocalServer");
  expect(preload).toContain("function currentServerUrl");
  expect(preload).not.toContain("getLocalAuthHeaders");
  expect(viteConfig).toContain('base: "./"');
  expect(preload).toContain("health:");
  expect(preload).toContain("listChats:");
  expect(preload).toContain("listNavigation:");
  expect(preload).toContain("getNewChatBriefing:");
  expect(preload).toContain('"/new-chat-briefing"');
  expect(preload).toContain('params.set("project_id", projectId)');
  expect(preload).toContain("listProjects:");
  expect(preload).toContain("getModelCatalog:");
  expect(preload).toContain("createProject:");
  expect(preload).toContain("selectProjectFolder:");
  expect(preload).toContain(
    'ipcRenderer.invoke("butler:select-project-folder")',
  );
  expect(preload).toContain("listSessions:");
  expect(preload).toContain("createSession:");
  expect(preload).toContain("initial_message: initialMessage");
  expect(preload).toContain("listProjectSessions:");
  expect(preload).toContain("listMessages:");
  expect(preload).toContain("readCachedMessages:");
  expect(preload).toContain("writeCachedMessages:");
  expect(preload).toContain("butler.message-cache.v1");
  expect(preload).toContain("hydrateMessageCacheFromLocalStorage");
  expect(preload).toContain("const messageCacheMemory");
  expect(preload).not.toContain("butler:read-message-cache");
  expect(preload).toContain("readCachedAppUiState:");
  expect(preload).toContain("writeCachedAppUiState:");
  expect(preload).toContain("butler.app-ui-state.v1");
  expect(preload).toContain("globalThis.localStorage");
  expect(preload).toContain("uploadMessageFile:");
  expect(preload).toContain("FormData");
  expect(preload).toContain('"/message-files"');
  expect(preload).toContain("sendMessage:");
  expect(preload).toContain("replayEvents:");
  expect(preload).toContain("subscribeLiveEvents");
  expect(preload).toContain("accept: \"text/event-stream\"");
  expect(preload).toContain("/events/live");
  expect(preload).toContain("listTurns:");
  expect(preload).toContain("retryTurn:");
  expect(preload).toContain("cancelTurn:");
  expect(preload).toContain("getSettings:");
  expect(preload).toContain("updateSettings:");
  expect(preload).toContain("getProfileImportPrompt:");
  expect(preload).toContain("importPersonalizationProfile:");
  expect(preload).toContain("searchCommandPalette:");
  expect(preload).toContain("getSessionSummary:");
  expect(preload).toContain("saveMessageFile:");
  expect(preload).toContain('ipcRenderer.invoke("butler:save-message-file"');
  expect(preload).toContain("getContextDetails:");
  expect(preload).toContain("getUsageMonitor:");
  expect(preload).toContain("exportTranscript:");
  expect(preload).toContain("listAutomations:");
  expect(preload).toContain("createAutomation:");
  expect(preload).toContain("runAutomation:");
  expect(preload).toContain("listWorkerActivity:");
  expect(preload).toContain("controlWorkerActivity:");
  expect(preload).not.toContain("child_process");
  expect(renderer).toContain("window.butlerApp");
  expect(renderer).toContain("subscribeLiveEvents");
  expect(renderer).toContain("new EventSource(liveEventsUrl");
  expect(renderer).toContain("function bridgeRequest");
  expect(renderer).toContain("function canSelectProjectFolder");
  expect(renderer).toContain("project_folder_picker_unavailable");
});

test("artifact cards keep card-open semantics and desktop save uses the filesystem dialog", () => {
  const electronMain = read("packages/butler-app/client/electron/main.mjs");
  const preload = read("packages/butler-app/client/electron/preload.cjs");
  const artifactActions = read(
    "packages/butler-app/client/ui/src/components/artifacts/artifactActions.tsx",
  );
  const artifactList = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ArtifactList/ArtifactList.tsx",
  );
  const documentTile = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/DocumentTile/DocumentTile.tsx",
  );

  expect(electronMain).toContain('ipcMain.handle("butler:save-message-file"');
  expect(electronMain).toContain("dialog.showSaveDialog");
  expect(electronMain).toContain("writeFile(result.filePath, bytes)");
  expect(electronMain).toContain(
    "new URL(`/message-files/${encodeURIComponent(fileId)}`",
  );
  expect(preload).toContain("saveMessageFile:");
  expect(artifactActions).toContain("saveDesktopArtifact");
  expect(artifactActions).toContain("window.butlerApp?.saveMessageFile");
  expect(artifactActions).toContain('id: "save"');
  expect(artifactActions).not.toContain('id: "open"');
  expect(artifactActions).not.toContain("Eye");
  expect(artifactList).toContain('role={isClickable ? "button" : undefined}');
  expect(artifactList).toContain("event.stopPropagation()");
  expect(artifactList).toContain('size="sm"');
  expect(documentTile).toContain(
    'role={isTileClickable ? "button" : undefined}',
  );
  expect(documentTile).toContain("event.stopPropagation()");
});

test("UI polish contracts keep titlebar, context legend, and project collapse behavior aligned", () => {
  const titlebar = read(
    "packages/butler-app/client/ui/src/components/layout/Titlebar.tsx",
  );
  const sidebarDirectItem = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarDirectItem.tsx",
  );
  const keyValueRowStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/KeyValueRow/KeyValueRow.module.css",
  );
  const keyValueRow = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/KeyValueRow/KeyValueRow.tsx",
  );
  const contextPanel = read(
    "packages/butler-app/client/ui/src/components/inspector/ContextPanel.tsx",
  );
  const contextCategoryRow = read(
    "packages/butler-app/client/ui/src/components/inspector/ContextCategoryRow.tsx",
  );
  const stack = read(
    "packages/butler-app/client/ui/src/libs/design-system/components/Stack/Stack.tsx",
  );
  const scrollArea = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ScrollArea/ScrollArea.tsx",
  );
  const scrollAreaStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ScrollArea/ScrollArea.module.css",
  );
  const inspectorShellStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/InspectorShell/InspectorShell.module.css",
  );
  const inspectorLayout = read(
    "packages/butler-app/client/ui/src/components/inspector/inspectorLayout.ts",
  );
  const rightPanelOverlayTitlebar = read(
    "packages/butler-app/client/ui/src/components/layout/RightPanelOverlayTitlebar.tsx",
  );
  const chromeFrame = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ChromeFrame/ChromeFrame.tsx",
  );
  const composerControlStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerControl/ComposerControl.module.css",
  );
  const titlebarShell = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/TitlebarShell/TitlebarShell.tsx",
  );
  const titlebarShellStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/TitlebarShell/TitlebarShell.module.css",
  );
  const appShell = read("packages/butler-app/client/ui/src/pages/AppShell.tsx");
  const narrowRightPanelHook = read(
    "packages/butler-app/client/ui/src/hooks/useNarrowRightPanelAutoCollapse.ts",
  );
  const section = read(
    "packages/butler-app/client/ui/src/libs/design-system/components/Section/Section.tsx",
  );
  const shellStyles = read(
    "packages/butler-app/client/ui/src/pages/Shell.module.css",
  );
  const electronMain = read("packages/butler-app/client/electron/main.mjs");
  const projectCollapseHook = read(
    "packages/butler-app/client/ui/src/components/layout/useSidebarProjectCollapse.ts",
  );

  expect(titlebar).not.toContain("setCommandOpen");
  expect(titlebar).not.toContain("appCopy.titlebar.commandPalette");
  expect(titlebar).toContain("MessageSquarePlus");
  expect(titlebar).toContain('data-test-class="titlebar-new-chat-button"');
  expect(titlebar).toContain('leadingVisibility="narrow"');
  expect(sidebarDirectItem).toContain("setCommandOpen(true)");
  expect(keyValueRowStyles).toMatch(/\.row\s*\{[\s\S]*align-items:\s*start;/);
  expect(keyValueRowStyles).toContain(".labelGroup");
  expect(keyValueRowStyles).toMatch(
    /\.labelGroup\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*align-items:\s*center;/,
  );
  expect(keyValueRowStyles).not.toContain("transform: translateY");
  expect(keyValueRowStyles).toContain(".valueCaption");
  expect(keyValueRowStyles).toContain(".detailStack");
  expect(keyValueRowStyles).not.toContain("margin-top: 4px");
  expect(keyValueRow).toContain('valueTextSize?: "body" | "caption"');
  expect(keyValueRow).toContain('detailAlign?: "center" | "start"');
  expect(keyValueRow).toContain('detailLayout?: "row" | "stack"');
  expect(keyValueRow).toContain('data-test-class="key-value-label-group"');
  expect(keyValueRow).toContain('data-test-class="key-value-value"');
  expect(keyValueRow).toContain('data-test-class="key-value-description"');
  expect(keyValueRow).toContain('data-test-class="key-value-meta"');
  expect(composerControlStyles).toContain(
    '[data-test-class~="composer-control-icon"]',
  );
  expect(composerControlStyles).toContain("line-height: 0");
  expect(composerControlStyles).toContain("display: block");
  expect(contextPanel).toContain("ScrollArea");
  expect(contextPanel).toContain('dataTestClass="context-legend-scroll"');
  expect(contextPanel).toContain('data-test-class="context-legend"');
  expect(contextPanel).toContain("inspectorLayout.ts");
  expect(contextPanel).toContain("style={contextSectionInset}");
  expect(contextPanel).toContain("style={contextLegendFrame}");
  expect(contextPanel).toContain("contentStyle={contextLegendContent}");
  expect(inspectorLayout).toContain("contextLegendFrame");
  expect(inspectorLayout).toContain("width: `calc(100% -");
  expect(inspectorLayout).toContain('"--scroll-area-frame-width"');
  expect(inspectorLayout).toContain('"--scroll-area-content-width": "100%"');
  expect(inspectorLayout).toContain("paddingInlineEnd");
  expect(inspectorLayout).toContain('"--scroll-area-scrollbar-offset": "18px"');
  expect(contextPanel).toContain("fill");
  expect(contextPanel).toContain('detailLayout="stack"');
  expect(contextPanel).toContain('valueTextSize="caption"');
  expect(contextCategoryRow).toContain('detailAlign="start"');
  expect(contextCategoryRow).toContain('valueTextSize="caption"');
  expect(stack).toContain("fill?: boolean");
  expect(section).toContain("contentFill?: boolean");
  expect(scrollArea).toContain("fill?: boolean");
  expect(scrollAreaStyles).toContain("--scroll-area-frame-width");
  expect(scrollAreaStyles).toContain("--scroll-area-content-width");
  expect(scrollAreaStyles).toContain("box-sizing: border-box");
  expect(inspectorShellStyles).toContain("--inspector-inline-padding: 18px");
  expect(inspectorShellStyles).toContain("padding: 0");
  expect(inspectorShellStyles).toContain("width: 100%");
  expect(inspectorShellStyles).not.toContain("padding: 0 18px 22px");
  expect(shellStyles).toContain("--shell-right-column-width");
  expect(shellStyles).toContain("--shell-left-column-target-width");
  expect(shellStyles).toContain("--shell-right-column-target-width");
  expect(shellStyles).toContain(":global(.right-panel-slot)");
  expect(shellStyles).toContain(
    'right-panel-slot [data-test-class~="right-inspector"]',
  );
  expect(shellStyles).toContain("contain: layout paint style");
  expect(shellStyles).toContain("@media (width<=640px)");
  expect(shellStyles).toContain(":global(.mac-window.right-open)");
  expect(shellStyles).toContain("right-panel-overlay-titlebar");
  expect(shellStyles).toContain("padding-top: var(--titlebar-height)");
  expect(shellStyles).toContain("chrome-floating-toggle-layer");
  const leftCollapsedBlock =
    shellStyles.match(
      /:global\(\.mac-window\.left-collapsed\)\s*\{[^}]*\}/u,
    )?.[0] ?? "";
  expect(leftCollapsedBlock).not.toContain("grid-template-columns");
  expect(shellStyles).not.toMatch(
    /:global\(\.right-inspector\)\s*\{[^}]*display:\s*none/u,
  );
  expect(appShell).toContain("useNarrowRightPanelAutoCollapse");
  expect(narrowRightPanelHook).toContain('"(max-width: 640px)"');
  expect(narrowRightPanelHook).toContain("setLeftOpen(false)");
  expect(titlebarShell).toContain('leadingVisibility?: "always" | "narrow"');
  expect(titlebarShellStyles).toContain('[data-visibility="narrow"]');
  expect(rightPanelOverlayTitlebar).toContain(
    "function RightPanelOverlayTitlebar",
  );
  expect(rightPanelOverlayTitlebar).toContain(
    "appCopy.titlebar.hideRightPanel",
  );
  expect(rightPanelOverlayTitlebar).toContain(
    'className="right-panel-overlay-titlebar drag-region"',
  );
  expect(rightPanelOverlayTitlebar).not.toContain("no-drag");
  expect(shellStyles).toContain("-webkit-app-region: drag");
  expect(chromeFrame).toContain(
    'data-test-class="chrome-floating-toggle-layer"',
  );
  expect(electronMain).toContain("minWidth: 320");
  expect(projectCollapseHook).toContain("if (projectsCollapsed)");
  expect(projectCollapseHook).toContain("setProjectsCollapsed(false)");
});

test("desktop native shell supports notifications tray and cross-platform titlebar reserves", () => {
  const electronMain = read("packages/butler-app/client/electron/main.mjs");
  const electronPreload = read(
    "packages/butler-app/client/electron/preload.cjs",
  );
  const appShell = read("packages/butler-app/client/ui/src/pages/AppShell.tsx");
  const appApi = read("packages/butler-app/client/ui/src/app/api.ts");
  const appCopy = read("packages/butler-app/client/ui/src/app/copy.ts");
  const titlebar = read(
    "packages/butler-app/client/ui/src/components/layout/Titlebar.tsx",
  );
  const nativeWindowControls = read(
    "packages/butler-app/client/ui/src/app/nativeWindowControls.ts",
  );
  const nativeNotifications = read(
    "packages/butler-app/client/ui/src/app/nativeNotifications.ts",
  );
  const generalSettings = read(
    "packages/butler-app/client/ui/src/components/settings/GeneralSettings.tsx",
  );
  const desktopShellSettings = read(
    "packages/butler-app/client/ui/src/components/settings/DesktopShellSettings.tsx",
  );
  const nativeNotificationStatusPanel = read(
    "packages/butler-app/client/ui/src/components/settings/NativeNotificationStatusPanel.tsx",
  );
  const shellStyles = read(
    "packages/butler-app/client/ui/src/pages/Shell.module.css",
  );
  const titlebarShellStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/TitlebarShell/TitlebarShell.module.css",
  );
  const packageJson = JSON.parse(
    read("packages/butler-app/client/electron/package.json"),
  );

  expect(electronMain).toContain("Tray");
  expect(electronMain).toContain("Notification");
  expect(electronMain).toContain("butler:show-desktop-notification");
  expect(electronMain).toContain("butler:get-native-notification-status");
  expect(electronMain).toContain("butler:test-desktop-notification");
  expect(electronMain).toContain("butler:open-native-notification-settings");
  expect(electronMain).toContain("openNativeNotificationSettings");
  expect(electronMain).toContain("x-apple.systempreferences");
  expect(electronMain).toContain("ms-settings:notifications");
  expect(electronMain).toContain("butler:set-native-shell-preferences");
  expect(electronMain).toContain("butler:native-navigation");
  expect(electronMain).toContain("butler:window-minimize");
  expect(electronMain).toContain("butler:window-toggle-maximize");
  expect(electronMain).toContain("butler:window-close");
  expect(electronMain).toContain("win.minimize()");
  expect(electronMain).toContain("win.isMaximized()");
  expect(electronMain).toContain("win.close()");
  expect(electronMain).toContain("nativeNotificationStatus");
  expect(electronMain).toContain("details_code");
  expect(electronMain).toContain("settings_target");
  expect(electronMain).not.toContain("notificationPlatformDetails(");
  expect(electronMain).not.toContain("settings_label:");
  expect(electronMain).toContain("Notification.isSupported");
  expect(electronMain).toContain("failed");
  expect(electronMain).toContain("refreshTrayMenu");
  expect(electronMain).toContain("trayAgentServiceStatus");
  expect(electronMain).toContain("createTrayAgentMenuModel");
  expect(electronMain).toContain("createAppAgentNativeServiceBridge");
  expect(electronMain).toContain("createAppAgentServiceAdapter");
  expect(electronMain).toContain("reconcileAgentServiceOnAppLaunch");
  expect(electronMain).toContain("reconcileAppAgentServiceForLaunch");
  expect(electronMain).toContain("let appAgentLaunchReconcilePromise = null");
  expect(electronMain).toContain("appManagedAgentRuntimeCurrent");
  expect(electronMain).toContain("currentBundledAgentVersion");
  expect(electronMain).toContain('source: "app-launch"');
  expect(electronMain).toContain("bundled_agent_version");
  expect(electronMain).toContain(
    "const launchReconcile = reconcileAppAgentServiceForLaunch();\n  if (rendererUrl === serverUrl && shouldUseAppAgentNativeServiceBridge()) {\n    await launchReconcile;\n    await ensureServer();\n  }",
  );
  expect(electronMain).toContain("adapter: appAgentServiceAdapter");
  expect(electronMain).toContain("MENU_BAR_HELPER_ARG");
  expect(electronMain).toContain("isQuitMainUiSignalMode");
  expect(electronMain).toContain("isQuitMenuBarHelperSignalMode");
  expect(electronMain).toContain("persistentMenuBarHelperSupported");
  expect(electronMain).toContain("shouldLaunchPersistentMenuBarHelper");
  expect(electronMain).toContain("BUTLER_APP_ELECTRON_USER_DATA_DIR");
  expect(electronMain).toContain('app.setPath("userData", explicitElectronUserDataDir)');
  expect(electronMain).toContain("function appLaunchCwd()");
  expect(electronMain).toContain("app.isPackaged ? dirname(process.execPath) : __dirname");
  expect(electronMain).toContain("mainProcessOwnsTray");
  expect(electronMain).toContain("helperProcessOwnsTray");
  expect(electronMain).toContain("ensurePersistentMenuBarHelper");
  expect(electronMain).toContain("launch failed");
  expect(electronMain).toContain("exited before handoff");
  expect(electronMain).toContain("did not publish a pid after launch");
  expect(electronMain).toContain("did not clear pid after quit signal");
  expect(electronMain).toContain("signalProcessHardExitDelayMs");
  expect(electronMain).toContain("scheduleSignalProcessHardExit");
  expect(electronMain).toContain("runTrayAgentServiceAction");
  expect(electronMain).toContain("Start Butler Agent");
  expect(electronMain).toContain("Restart Butler Agent");
  expect(electronMain).toContain("Stop Butler Agent");
  expect(electronMain).toContain("Stop Butler Agent?");
  expect(electronMain).toContain("Do not show this warning again");
  expect(electronMain).not.toContain("Quit Butler UI");
  expect(electronMain).not.toContain("Quit Menu Bar Helper");
  expect(electronMain).toContain("process.exit(0)");
  expect(electronMain).not.toContain('tray.on("click"');
  expect(electronMain).not.toContain("openButlerFromTray();\n    });");
  expect(electronMain).not.toContain('BUTLER_APP_MENU_BAR_HELPER: "1"');
  expect(electronMain).toContain("function activateButlerApp()");
  expect(electronMain).toContain("if (isMenuBarHelperProcess) {\n    openButlerFromTray();");
  expect(electronMain).toContain('app.on("activate", activateButlerApp)');
  expect(electronMain).toContain("menu-bar-helper");
  expect(electronMain).toContain("trayActionSource()");
  expect(electronMain).toContain(
    "agentServiceControl.startAgentService({ source: trayActionSource() })",
  );
  expect(electronMain).toContain(
    "agentServiceControl.stopAgentService({ source: trayActionSource() })",
  );
  expect(electronMain).toContain(
    "agentServiceControl.restartAgentService({ source: trayActionSource() })",
  );
  expect(electronMain).toContain(
    'const trayIconLightThemePath = resolve(__dirname, "assets/butler-mark-flat.png")',
  );
  expect(electronMain).toContain(
    'const trayIconDarkThemePath = resolve(__dirname, "assets/butler-mark-flat-white.png")',
  );
  expect(electronMain).toContain("nativeTheme.shouldUseDarkColors");
  expect(electronMain).toContain("tray.setImage(trayIconForMenuBar())");
  expect(electronMain).toContain('nativeTheme.on("updated", updateTrayIcon)');
  expect(electronMain).toContain("desktop_tray_enabled");
  expect(electronMain).toContain("event.preventDefault()");
  expect(electronMain).toContain("win.hide()");
  expect(electronPreload).toContain("showDesktopNotification");
  expect(electronPreload).toContain("getNativeNotificationStatus");
  expect(electronPreload).toContain("testDesktopNotification");
  expect(electronPreload).toContain("openNativeNotificationSettings");
  expect(electronPreload).toContain("setNativeShellPreferences");
  expect(electronPreload).toContain("onNativeNavigation");
  expect(electronPreload).toContain("minimizeWindow");
  expect(electronPreload).toContain("toggleWindowMaximize");
  expect(electronPreload).toContain("closeWindow");
  expect(appApi).toContain("showDesktopNotification?:");
  expect(appApi).toContain("getNativeNotificationStatus?:");
  expect(appApi).toContain("testDesktopNotification?:");
  expect(appApi).toContain("openNativeNotificationSettings?:");
  expect(nativeNotifications).toContain("NativeNotificationStatus");
  expect(nativeNotifications).toContain("getNativeNotificationStatus");
  expect(nativeNotifications).toContain("testDesktopNotification");
  expect(nativeNotifications).toContain("openNativeNotificationSettings");
  expect(nativeNotifications).toContain("nativeNotificationStatusDetails");
  expect(nativeNotifications).toContain("appCopy.settings.nativeNotifications");
  expect(nativeNotifications).toContain("setNativeShellPreferences");
  expect(nativeNotifications).toContain("showDesktopNotification");
  expect(nativeNotifications).toContain("subscribeNativeNavigation");
  expect(appCopy).toContain("nativeNotifications");
  expect(appCopy).toContain("minimizeWindow");
  expect(appCopy).toContain("maximizeWindow");
  expect(appCopy).toContain("closeWindow");
  expect(appCopy).toContain("macosPermission");
  expect(nativeWindowControls).toContain('bridge.platform === "darwin"');
  expect(nativeWindowControls).toContain("shouldShowAppWindowControls");
  expect(titlebar).toContain("windowControls={<WindowControls />}");
  const windowControls = read(
    "packages/butler-app/client/ui/src/components/layout/WindowControls.tsx",
  );
  expect(windowControls).toContain('data-test-class="app-window-controls"');
  expect(windowControls).toContain("minimizeNativeWindow");
  expect(windowControls).toContain("toggleNativeWindowMaximize");
  expect(windowControls).toContain("closeNativeWindow");
  expect(appShell).toContain("platformClassName()");
  expect(appShell).toContain("useNativeShellPreferences");
  expect(generalSettings).toContain("DesktopShellSettings");
  expect(desktopShellSettings).toContain("settingsSections.notifications");
  expect(desktopShellSettings).toContain("settingsSections.desktopShell");
  expect(desktopShellSettings).toContain("desktop_notifications");
  expect(desktopShellSettings).toContain("desktop_tray_enabled");
  expect(desktopShellSettings).toContain("SettingsSwitch");
  expect(desktopShellSettings).toContain("NativeNotificationStatusPanel");
  expect(nativeNotificationStatusPanel).toContain("getNativeNotificationStatus");
  expect(nativeNotificationStatusPanel).toContain("testDesktopNotification");
  expect(nativeNotificationStatusPanel).toContain("openNativeNotificationSettings");
  expect(shellStyles).toContain(":global(.electron-chrome.platform-win32)");
  expect(shellStyles).toContain("--window-controls-width");
  expect(shellStyles).toContain("--traffic-controls-width: 0px");
  expect(shellStyles).toContain("--chrome-floating-toggle-left: 10px");
  expect(shellStyles).toContain("border-radius: var(--app-window-radius)");
  expect(shellStyles).toContain("padding: var(--app-window-frame-inset)");
  expect(titlebarShellStyles).toContain(
    "padding-right: calc(18px + var(--window-controls-width, 0px))",
  );
  expect(titlebarShellStyles).toContain("windowControls");
  expect(titlebarShellStyles).toContain("inset-inline-end: 10px");
  expect(titlebarShellStyles).toContain("position: absolute");
  expect(packageJson.scripts).toHaveProperty("package:win");
  expect(packageJson.scripts).toHaveProperty("package:linux");
});

test("mac menu bar helper does not report installed service plist as missing Agent", () => {
  const helperSource = read("packages/butler-app/client/electron/native/menu-bar-helper.swift");

  expect(helperSource).toContain("FileManager.default.fileExists(atPath: launchAgentPlistPath)");
  expect(helperSource).toContain('label: "Butler Agent: Stopped"');
  expect(helperSource).toContain('label: "Butler Agent: Not Installed"');
  expect(helperSource).toContain("canStart: false");
});

test("mac menu bar helper opens main App without leaking helper mode", () => {
  const helperSource = read("packages/butler-app/client/electron/native/menu-bar-helper.swift");

  expect(helperSource).toContain("configuration.environment = mainAppEnvironment()");
  expect(helperSource).toContain('env["BUTLER_APP_MENU_BAR_HELPER"] = ""');
  expect(helperSource).toContain('env["BUTLER_APP_MENU_BAR_HELPER_PID_FILE"] = ""');
  expect(helperSource).toContain("processLooksLikeCurrentHelper(pid)");
  expect(helperSource).toContain(
    "let expectedBundleIdentifier = Bundle.main.bundleIdentifier",
  );
  expect(helperSource).toContain("return bundleIdentifier == expectedBundleIdentifier");
});

test("navigation UI is backed by app-server data rather than sidebar fixtures", () => {
  const renderer = readUiSources();

  expect(renderer).toContain('api<NavigationView>("/navigation")');
  expect(renderer).toContain('api<{ project: ProjectSummary }>("/projects"');
  expect(renderer).toContain("const projects = navigation.projects ?? []");
  expect(renderer).toContain("const chats = navigation.chats ?? []");
  expect(renderer).toContain("projects.map((project) =>");
  expect(renderer).toContain("chats.map((chat) =>");
  expect(renderer).toContain("function SidebarProjectGroup");
  expect(renderer).toContain("project.sessions ?? []");
  expect(renderer).toContain("function selectProjectFolder");
  expect(renderer).toContain("canSelectProjectFolder");
  expect(renderer).toContain("creatingProject || !folderPickerAvailable");
  expect(renderer).toContain("function projectDraftId");
  expect(renderer).toContain("sidebarCopy.startFromScratch");
  expect(renderer).toContain("sidebarCopy.useExistingFolder");
  expect(renderer).toContain("runProjectAction: async (project, action)");
  expect(renderer).toContain("appCopy.sidebar.projectDashboard");
  expect(renderer).toContain("appCopy.sessionActions.rename");
  expect(renderer).toContain("function ProjectRenameDialog");
  expect(renderer).toContain("set({ renameProject: project })");
  expect(renderer).toContain("appCopy.sessionActions.archive");
  expect(renderer).not.toContain("window.prompt");
  expect(renderer).not.toContain("const PROJECTS =");
  expect(renderer).not.toContain("const RECENT_CHATS =");
  expect(renderer).not.toContain('label="Plugins"');
});

test("electron shell mediates existing-folder project selection without exposing raw filesystem APIs", () => {
  const electronMain = read("packages/butler-app/client/electron/main.mjs");
  const preload = read("packages/butler-app/client/electron/preload.cjs");

  expect(electronMain).toContain(
    'ipcMain.handle("butler:select-project-folder"',
  );
  expect(electronMain).toContain("dialog.showOpenDialog");
  expect(electronMain).toContain(
    'properties: ["openDirectory", "createDirectory"]',
  );
  expect(electronMain).toContain("BUTLER_PROJECT_FOLDER_TOKEN_SECRET");
  expect(electronMain).toContain("project-folder-token-secret");
  expect(electronMain).toContain("resolveProjectFolderTokenSecret");
  expect(electronMain).toContain("createProjectFolderSelectionToken");
  expect(preload).toContain("folder_selection_token");
  expect(preload).not.toContain("showOpenDialog");
  expect(preload).not.toContain("fs/promises");
});

test("conversation UI renders user bubbles and assistant documents with runtime-fault retry actions", () => {
  const renderer = readUiSources();
  const messageItem = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageItem.tsx",
  );
  const messageList = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageList.tsx",
  );
  const conversation = read(
    "packages/butler-app/client/ui/src/components/conversation/Conversation.tsx",
  );
  const emptyState = read(
    "packages/butler-app/client/ui/src/components/conversation/EmptyState.tsx",
  );
  const virtualMessageRow = read(
    "packages/butler-app/client/ui/src/components/conversation/VirtualMessageRow.tsx",
  );
  const conversationUtils = read(
    "packages/butler-app/client/ui/src/components/conversation/conversationUtils.tsx",
  );
  const messageMarkdown = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageMarkdown.tsx",
  );
  const messageMedia = read(
    "packages/butler-app/client/ui/src/components/conversation/messageMedia.ts",
  );
  const autoScroll = read(
    "packages/butler-app/client/ui/src/components/conversation/hooks/useConversationAutoScroll.ts",
  );
  const composerTextArea = read(
    "packages/butler-app/client/ui/src/components/conversation/ComposerTextArea.tsx",
  );
  const composerKeyboard = read(
    "packages/butler-app/client/ui/src/components/conversation/hooks/useComposerKeyboard.ts",
  );
  const composerCard = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerCard/ComposerCard.tsx",
  );
  const composerCardStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerCard/ComposerCard.module.css",
  );
  const promptSuggestionList = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/PromptSuggestionList.tsx",
  );
  const promptSuggestionCard = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/PromptSuggestionCard.tsx",
  );
  const promptSuggestionListStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/PromptSuggestionList.module.css",
  );
  const conversationShellStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ConversationShell/ConversationShell.module.css",
  );
  const markdownContentStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/MarkdownContent/MarkdownContent.module.css",
  );
  const promptFluid = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/promptFluid.ts",
  );
  const promptFluidShaders = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/promptFluidShaders.ts",
  );
  const promptFluidPalettes = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/PromptSuggestionList/promptFluidPalettes.ts",
  );
  const normalizedComposerCardStyles = collapseWhitespace(composerCardStyles);
  const messageVirtualizer = read(
    "packages/butler-app/client/ui/src/components/conversation/hooks/useMessageVirtualizer.ts",
  );
  const css = readUiStyleSources();

  expect(renderer).toContain("function MessageList");
  expect(renderer).toContain("useVirtualizer");
  expect(messageList).toContain("useConversationAutoScroll");
  expect(messageVirtualizer).toContain("getItemKey");
  expect(messageList).toContain("getVirtualItems");
  expect(messageList).not.toContain("scrollToIndex");
  expect(messageItem).not.toContain("state.summary");
  expect(conversationUtils).not.toContain("SessionSummaryView");
  expect(autoScroll).toContain("useLayoutEffect");
  expect(autoScroll).toContain("latestMessageVersion");
  expect(autoScroll).toContain("virtualListHeight");
  expect(autoScroll).not.toContain("lastContentVersionRef");
  expect(autoScroll).not.toContain("contentChanged");
  expect(autoScroll).not.toContain("lastKnownUnpinnedScrollTopRef");
  expect(autoScroll).not.toContain("SCROLL_DRIFT_RESTORE_TOLERANCE");
  expect(autoScroll).not.toContain("element.scrollTop = expectedScrollTop");
  expect(autoScroll).toContain("cancelScheduledScroll()");
  expect(autoScroll).toContain("distanceFromBottom < BOTTOM_LOCK_THRESHOLD");
  expect(autoScroll).toContain(
    "const shouldPin = enteringChat || pinnedToBottomRef.current;",
  );
  expect(autoScroll).not.toContain("canFollowActiveContent");
  expect(autoScroll).not.toContain(
    "pinnedToBottomRef.current ||\n    isSending",
  );
  expect(autoScroll).not.toContain("pinnedToBottomRef.current || enteringChat");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).toContain("if (cursor > 0)");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).toContain("setMessageListView(cached)");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).toContain("setSessionView(data)");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).not.toContain("setTurnProgress(cached.turn_progress");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).not.toContain("setMessages(cached.messages");
  expect(conversation).toContain("messageLoadPending");
  expect(conversation).toContain("showEmptyState");
  expect(conversation).toContain("const composerLarge = true");
  expect(conversation).toContain("newChatTitleIconSize");
  expect(conversation).toContain("newChatTitleIconGap");
  expect(conversation).toContain("newChatTitleIconGutter");
  expect(conversation).toContain(
    "calc(clamp(40px, 5.333vw, 54px) + clamp(40px, 5.333vw, 54px) + 10px)",
  );
  expect(conversation).toContain("contentGutter={newChatTitleIconGutter}");
  expect(conversation).toContain("titleIconGap={newChatTitleIconGap}");
  expect(conversation).toContain("titleIconSize={newChatTitleIconSize}");
  expect(conversation).toContain(
    "<ConversationScroll masked={false} scrollable={false}>",
  );
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/ConversationShell/ConversationShell.tsx",
    ),
  ).toContain("scrollable = true");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/ConversationShell/ConversationShell.tsx",
    ),
  ).toContain("contentGutter");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/ConversationShell/ConversationShell.tsx",
    ),
  ).toContain("titleIconGap");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/ConversationShell/ConversationShell.tsx",
    ),
  ).toContain("titleIconSize");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/ConversationShell/ConversationShell.module.css",
    ),
  ).toContain(".lockedScroll");
  expect(conversation).toContain("large={composerLarge}");
  expect(conversation).not.toContain("large={showEmptyState}");
  expect(conversation).not.toContain("large={!hasMessages}");
  expect(composerTextArea).toContain("COMPOSER_MAX_AUTO_ROWS = 8");
  expect(composerTextArea).toContain("resizeComposerTextArea");
  expect(composerTextArea).toContain("data-max-auto-rows");
  expect(composerCardStyles).toContain("--composer-inner-padding-block");
  expect(composerCardStyles).toContain("--composer-inner-padding-inline");
  expect(composerCard).toContain("tintedGlassSurfaceClassName");
  expect(composerCard).toContain('data-radius="composer"');
  expect(composerCardStyles).not.toContain("--composer-glass-glint");
  expect(normalizedComposerCardStyles).toContain(
    "8lh + var(--composer-inner-padding-block) + var(--composer-inner-padding-block)",
  );
  expect(normalizedComposerCardStyles).toContain(
    ".toolbar { display: flex; min-height: 42px; align-items: center; gap: var(--space-1); border-top: 1px solid var(--composer-glass-divider); padding: var(--space-2);",
  );
  expect(composerKeyboard).toContain("shouldSubmitComposerEnter");
  expect(composerKeyboard).toContain("modifier_enter_send_enter_newline");
  expect(read("packages/butler-app/client/ui/src/app/store.ts")).toContain(
    "sessionMessageViews",
  );
  expect(read("packages/butler-app/client/ui/src/app/store.ts")).toContain(
    "snapshotActiveSessionView",
  );
  expect(renderer).toContain("MessageListSurface");
  expect(renderer).toContain("ConversationShell");
  expect(renderer).toContain('message.role === "assistant"');
  expect(renderer).toContain('message.status === "failed"');
  expect(renderer).toContain("isRuntimeFaultRetryableMessage(message)");
  expect(renderer).toContain("onRetryTurn(turnId)");
  expect(renderer).toContain("eventPollingRef");
  expect(renderer).toContain("function collapseAssistantAttempts");
  expect(renderer).toContain("function WorkerComposerPanel");
  expect(renderer).toContain("function ContextPanel");
  expect(renderer).toContain("function ArtifactsPanel");
  expect(renderer).toContain("<DocumentTile");
  expect(renderer).not.toContain('data-test-class="artifact-detail"');
  expect(renderer).toContain("cancelActiveTurn");
  expect(renderer).toContain("Export app-visible transcript");
  expect(renderer).toContain("attachments={message.attachments}");
  expect(messageMarkdown).toContain("resolveMarkdownImageSource");
  expect(messageMarkdown).toContain('data-test-class="markdown-inline-image"');
  expect(messageMarkdown).toContain('decoding="async"');
  expect(messageMarkdown).toContain('loading="lazy"');
  expect(messageMedia).toContain("MESSAGE_FILE_URL_PATTERN");
  expect(messageMedia).toContain('attachment.kind === "image"');
  expect(messageMedia).toContain("normalizedFileName(attachment.safe_name)");
  expect(markdownContentStyles).toContain(".markdown img");
  expect(markdownContentStyles).toContain("max-width: 30%");
  expect(markdownContentStyles).toContain("height: auto");
  expect(renderer).toContain("<PromptSuggestionList");
  expect(renderer).toContain("onSelect: () => onSend(suggestion.text)");
  expect(emptyState).toContain('from "@/assets/butler-mark.png"');
  expect(emptyState).toContain('from "@/assets/butler-mark-white.png"');
  expect(emptyState).toContain(
    'titleIcon={<img alt="" draggable={false} src={titleIconSrc} />}',
  );
  expect(emptyState).toContain(
    "const momentLabel = briefing?.moment ?? newChatMomentLabel();",
  );
  expect(emptyState).toContain("moment={momentLabel}");
  expect(emptyState).not.toContain("<ButlerMarkIcon");
  expect(renderer).toContain("<ButlerMarkIcon");
  expect(promptSuggestionList).toContain("titleIcon");
  expect(promptSuggestionList).toContain(
    'data-slot="prompt-suggestion-title-copy"',
  );
  expect(promptSuggestionList).toContain("description");
  expect(promptSuggestionList).toContain("fluidBackground");
  expect(promptSuggestionList).toContain("fluidPalette");
  expect(promptSuggestionList).toContain("fluidPaletteOptions");
  expect(promptSuggestionList).toContain("fluidTone");
  expect(promptSuggestionList).toContain("fluidVariant");
  expect(promptSuggestionList).toContain("moment");
  expect(promptSuggestionCard).toContain("<TintedGlass");
  expect(promptSuggestionCard).toContain("prompt-suggestion-meta");
  expect(promptSuggestionCard).toContain("prompt-suggestion-title");
  expect(promptSuggestionCard).toContain("prompt-suggestion-description");
  expect(promptSuggestionList).not.toContain("suggestion.icon");
  expect(promptSuggestionList).not.toContain("suggestion.graphic");
  expect(renderer).toContain("<PromptFluidBackground");
  expect(promptSuggestionListStyles).toContain("grid-auto-flow: column");
  expect(promptSuggestionListStyles).toContain("overflow: auto hidden");
  expect(promptSuggestionListStyles).toContain(
    "height: calc(100vh - var(--composer-reserve))",
  );
  expect(promptSuggestionListStyles).toContain(
    "padding: var(--titlebar-height) 0 0",
  );
  expect(promptSuggestionListStyles).toContain(
    "inset: 0 0 0 var(--shell-left-column-target-width, 0)",
  );
  expect(promptSuggestionListStyles).toContain(
    "grid-auto-columns: minmax(198px, 224px)",
  );
  expect(promptSuggestionListStyles).not.toContain(".root::after");
  expect(promptSuggestionListStyles).not.toContain(".itemFrame::after");
  expect(promptSuggestionListStyles).not.toContain(".itemGraphic");
  expect(promptSuggestionListStyles).toContain("--tinted-glass-bg");
  expect(promptSuggestionListStyles).toContain("--tinted-glass-shadow: none");
  expect(promptSuggestionListStyles).toContain("min-height: 260px");
  expect(promptSuggestionListStyles).toContain(".paletteControl");
  expect(promptSuggestionListStyles).toContain(".paletteSwatch");
  expect(renderer).toContain("new-chat-fluid-gradient");
  expect(promptSuggestionListStyles).toContain("--typo-new-chat-title-size");
  expect(promptSuggestionListStyles).toContain(
    "--prompt-content-width: var(--conversation-content-width",
  );
  expect(promptSuggestionListStyles).toContain("--prompt-edge-gutter: var(");
  expect(promptSuggestionListStyles).toContain("--new-chat-title-edge-gutter");
  expect(promptSuggestionListStyles).toContain("--prompt-title-icon-gap");
  expect(promptSuggestionListStyles).toContain(
    "right: calc(100% + var(--prompt-title-icon-gap))",
  );
  expect(promptSuggestionListStyles).toContain(".titleIcon img");
  expect(promptSuggestionListStyles).toContain("object-fit: contain");
  expect(promptSuggestionListStyles).toContain(
    "border-radius: var(--workspace-left-radius, 18px) 0 0",
  );
  expect(conversationShellStyles).toContain("--conversation-content-width");
  expect(conversationShellStyles).not.toContain(":global(");
  expect(promptSuggestionListStyles).not.toContain(":global(");
  expect(promptSuggestionListStyles).not.toContain("--prompt-title-offset");
  expect(promptSuggestionListStyles).toContain("word-break: keep-all");
  expect(promptSuggestionListStyles).toContain("overflow-wrap: break-word");
  expect(promptFluidShaders).toContain("vec3 color=mix(base,liquid");
  expect(promptFluid).not.toContain("brightLiquid");
  expect(promptFluidPalettes).toContain("PROMPT_FLUID_PALETTES");
  expect(promptFluidPalettes).toContain("monochrome");
  expect(promptFluidPalettes).toContain("[50, 66, 77]");
  expect(promptFluidPalettes).toContain(
    "DEFAULT_PROMPT_FLUID_PALETTE = PROMPT_FLUID_PALETTES.monochrome",
  );
  expect(promptFluidPalettes).toContain("VIOLET_COLOR");
  expect(promptFluidPalettes).toContain("[139, 92, 246]");
  expect(promptFluidPalettes).toContain("INDIGO_COLOR");
  expect(promptFluidPalettes).toContain("[99, 102, 241]");
  expect(promptFluidPalettes).toContain("[56, 189, 248]");
  expect(promptFluidPalettes).toContain("[45, 212, 191]");
  expect(promptFluid).toContain("VISIBLE_LIQUID_SATURATION");
  expect(promptFluid).toContain("MAX_FLUID_CANVAS_PIXELS");
  expect(promptFluid).toContain("MAX_FLUID_PIXEL_RATIO");
  expect(promptFluid).toContain('powerPreference: "low-power"');
  expect(promptSuggestionListStyles).toContain("contain: strict");
  expect(promptSuggestionListStyles).not.toContain("filter: saturate(1.06)");
  expect(promptFluidShaders).toContain("uniform vec3 p0");
  expect(promptFluidShaders).toContain("uniform float d");
  expect(promptFluid).toContain("setPaletteUniforms");
  expect(promptFluid).toContain("FRAGMENT_SHADER");
  expect(promptFluid).toContain("SILK_FRAGMENT_SHADER");
  expect(promptFluid).toContain("createFluidRenderer");
  expect(promptFluid).toContain("FluidVariant");
  expect(promptFluid).toContain("FluidTone");
  expect(promptFluidShaders).toContain("float a1=blob");
  expect(promptFluidShaders).toContain("SILK_FRAGMENT_SHADER");
  expect(promptFluidShaders).toContain("silkNoise");
  expect(promptFluidShaders).toContain("rotateSilk");
  expect(promptFluidShaders).toContain("float fold=");
  expect(promptFluidShaders).toContain("vec3 color=mix(p0,shade");
  expect(renderer).toContain("function MainScreenThemeSettings");
  expect(renderer).toContain('draft.main_screen_theme === "bloom"');
  expect(renderer).toContain("paletteMonochrome");
  expect(renderer).toContain("settings-main-screen-theme-select");
  expect(renderer).toContain("settings-main-screen-theme-preset-select");
  expect(renderer).toContain("settings-main-screen-theme-color");
  expect(renderer).toContain("ColorSwatchInput");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/ColorSwatchInput/ColorSwatchInput.module.css",
    ),
  ).toContain(".root");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/ColorSwatchInput/ColorSwatchInput.module.css",
    ),
  ).toContain("border-radius: var(--radius-pill)");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/ColorSwatchInput/ColorSwatchInput.module.css",
    ),
  ).toContain(".input::-webkit-color-swatch");
  expect(renderer).toContain("mainScreenFluidEnabled");
  expect(renderer).toContain("mainScreenFluidPalette");
  expect(renderer).toContain("mainScreenFluidVariant");
  expect(renderer).toContain("SYSTEM_BACKGROUND_PALETTES");
  expect(renderer).toContain("main-screen-theme-bloom");
  expect(renderer).toContain("main-screen-theme-silk");
  expect(renderer).toContain("main-screen-theme-none");
  expect(renderer).toContain("function ComposerMenu");
  expect(renderer).toContain("modelCatalog");
  expect(renderer).not.toContain("showStatusPill");
  expect(renderer).toContain("ReactMarkdown");
  expect(renderer).toContain("remarkGfm");
  expect(renderer).toContain("const MARKDOWN_COMPONENTS");
  expect(renderer).toContain('target="_blank"');
  expect(renderer).toContain('rel="noreferrer"');
  expect(renderer).toContain("MarkdownContent");
  expect(renderer).toContain("function reasoningBudgetSummary");
  expect(renderer).toContain("function reasoningOptionLabel");
  expect(renderer).toContain("formatReasoningTokens");
  expect(renderer).toContain("function AssistantResponseFooter");
  expect(renderer).toContain("Copy assistant response");
  expect(renderer).toContain("Worked for");
  expect(renderer).toContain("formatWorkedDuration");
  expect(renderer).toContain("function ContextUsagePopover");
  expect(renderer).toContain("Context window:");
  expect(virtualMessageRow).toContain("MessageAvatar");
  expect(renderer).toContain("latestAssistantMessageId");
  expect(renderer).toContain("ChartContainer");
  expect(renderer).toContain("BarChart");
  expect(renderer).toContain("isAnimationActive={false}");
  expect(renderer).toContain("shouldSubmitComposerEnter");
  expect(renderer).toContain("appCopy.composer.attachFile");
  expect(renderer).toContain("uploadMessageFile");
  expect(renderer).toContain("uploadEpochRef");
  expect(css).toContain(".mac-window.right-open .workspace");
  expect(css).toContain("border-right-width: 0");
  expect(renderer).toContain("MESSAGE_FILE_URL_PATTERN");
  expect(renderer).toContain("function MessageAttachments");
  expect(renderer).toContain("function MessageArtifacts");
  expect(renderer).toContain('data-test-class="message-artifact-list"');
  expect(renderer).toContain("<ArtifactList");
  expect(renderer).toContain('data-test-class="artifact-viewer"');
  expect(renderer).toContain("message.artifacts");
  expect(renderer).toContain("openArtifact(artifact.id, artifact)");
  expect(renderer).toContain("selectedArtifactId");
  expect(renderer).toContain("selectedArtifact");
  expect(renderer).toContain("appCopy.inspector.tabs.summary");
  expect(renderer).toContain("composerControlsForSubmit");
  expect(renderer).toContain("attachments,");
  expect(renderer).toContain("file_id: attachment.file_id");
  expect(renderer).toContain('data-picker-filter="all-files"');
  expect(renderer).not.toContain("accept={ATTACHMENT_ACCEPT}");
  expect(renderer).toContain('role="alert"');
  expect(renderer).not.toContain("formatPromptWithAttachments");
  expect(renderer).toContain('status: "pending"');
  expect(renderer).toContain("rightAvailable");
  expect(renderer).toContain("model.runtime_supported === true");
  expect(renderer).not.toContain('model.provider_id === "openai"');
  expect(renderer).toContain('visualMode === "components"');
  expect(renderer).not.toContain('label="Voice"');
  expect(renderer).not.toContain("<Mic");
  expect(renderer).not.toContain("function CommandSheet");
  expect(renderer).not.toContain("ship-feature</div>");
  expect(renderer).not.toContain("File attachment unavailable");
  expect(renderer).not.toContain(
    "Access mode selector is not available in this build",
  );
  expect(renderer).not.toContain(
    "Model selector is not available in this build",
  );
  expect(renderer).not.toContain("Filter chats unavailable");
  expect(renderer).not.toContain("Project dashboard unavailable");
  expect(renderer).not.toContain(
    "Local data export is not available in this build",
  );
  expect(renderer).not.toContain(
    "Archived chat management is unavailable in this build",
  );
  expect(renderer).toContain("setCommandOpen(true)");
  expect(renderer).not.toContain("<button className={`project-row");
  expect(renderer).not.toContain(
    "Archived chat management is ready for server data",
  );
  expect(css).toContain(".user .body");
  expect(css).toContain("justify-content: end");
  expect(css).toContain("--conversation-content-width");
  expect(css).toContain("flex-direction: column");
  expect(css).toContain("width: var(--conversation-content-width)");
  expect(css).toContain("flex: 1 0 auto");
  expect(css).toContain("align-content: end");
  expect(css).toContain("width: fit-content");
  expect(css).toContain("max-width: min(440px, 68%)");
  expect(css).toContain(".pending .body");
  expect(css).toContain(".markdown h2");
  expect(css).toContain(".footer button");
  expect(css).toContain(".item");
  expect(css).toContain(".assistant .body");
  expect(css).toContain("background: transparent");
  expect(css).toContain("grid-template-columns: 28px minmax(0, 1fr)");
  expect(renderer).toContain("MessageRetryActions");
  expect(css).toContain(".floating");
  expect(renderer).toContain("<DocumentTile");
  expect(renderer).not.toContain('data-test-class="artifact-detail"');
  expect(renderer).toContain('clickTarget="tile"');
  expect(renderer).toContain('data-test-class="modal-card"');
  expect(renderer).not.toContain("modal-card liquid-glass-popover");
  expect(renderer).not.toContain("document-dialog");
  expect(css).toContain("position: absolute");
  expect(css).toContain("white-space: nowrap");
  expect(css).toContain("flex: 0 0 auto");
  expect(css).toContain(
    "max-height: calc(100vh - var(--titlebar-height) - 210px)",
  );
  expect(css).toContain("overflow: hidden");
  expect(css).not.toContain(".command-sheet");

  const messageArtifacts = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageArtifacts.tsx",
  );
  expect(messageArtifacts).toContain("artifactDescription(artifact)");
  expect(messageArtifacts).not.toContain("artifactMeta(artifact)");

  const messageContent = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageContent.tsx",
  );
  expect(messageContent.indexOf("<MessageArtifacts")).toBeLessThan(
    messageContent.indexOf("<AssistantResponseFooter"),
  );
});

test("electron shell owns only the app gateway process and shuts it down cleanly", () => {
  const electronMain = read("packages/butler-app/client/electron/main.mjs");
  const supervisor = read(
    "packages/butler-app/client/electron/app-agent-supervisor.mjs",
  );

  expect(electronMain).toContain("function stopServerProcess");
  expect(electronMain).toContain("app.requestSingleInstanceLock()");
  expect(electronMain).toContain('app.on("second-instance"');
  expect(electronMain).toContain("bundledAgentSupervisor.stop()");
  expect(supervisor).toContain('stopping.kill("SIGTERM")');
  expect(supervisor).toContain('stopping.kill("SIGKILL")');
  expect(supervisor).toContain("shutdownKillTimer");
  expect(electronMain).toContain("function managedGatewayCommand");
  expect(electronMain).toContain('"gateway", "app"');
  expect(electronMain).toContain("process.env.BUTLER_BUN");
  expect(electronMain).not.toContain(
    "packages/butler-agent/src/gateways/app/interface/cli/app-gateway-cli.ts",
  );
  expect(electronMain).not.toContain("service-control.sh");
  expect(supervisor).toContain("already starting but is not healthy");
  expect(supervisor).toContain("Failed to start Butler app server");
  expect(supervisor).toContain("exited before becoming healthy");
  expect(supervisor).toContain("async function checkGatewayReadiness");
  expect(supervisor).toContain("BUTLER_APP_GATEWAY_PID_FILE");
  expect(supervisor).toContain('child.once("exit"');
  expect(supervisor).toContain('child.once("error"');
  expect(supervisor).not.toContain("child.unref()");
  expect(electronMain).toContain('app.on("before-quit"');
  expect(electronMain).toContain('process.once("SIGINT"');
  expect(electronMain).toContain('process.once("SIGTERM"');
  expect(electronMain).not.toContain("Quit Butler UI");
  expect(electronMain).not.toContain("stopAgentService({ source: \"quit\" })");
  expect(electronMain).not.toContain("stopAgentService({ source: \"before-quit\" })");
});

test("conversation message context menu provides copy action", () => {
  const conversation = read(
    "packages/butler-app/client/ui/src/components/conversation/Conversation.tsx",
  );
  const messageItem = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageItem.tsx",
  );
  const virtualMessageRow = read(
    "packages/butler-app/client/ui/src/components/conversation/VirtualMessageRow.tsx",
  );
  const copy = read("packages/butler-app/client/ui/src/app/copy.ts");

  expect(virtualMessageRow).toContain('from "@/butler-ds"');
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/context-menu.tsx",
    ),
  ).toContain('data-slot="context-menu-content"');
  expect(conversation).toContain("<MessageList");
  expect(virtualMessageRow).toContain("ContextMenu");
  expect(virtualMessageRow).toContain("ContextMenuTrigger");
  expect(virtualMessageRow).toContain("ContextMenuContent");
  expect(virtualMessageRow).toContain("ContextMenuItem");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/conversation/hooks/useMessageList.ts",
    ),
  ).toContain("window.getSelection");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/conversation/hooks/useMessageList.ts",
    ),
  ).toContain("navigator.clipboard.writeText");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/context-menu.tsx",
    ),
  ).toContain('data-glass="popover"');
  expect(messageItem).toContain("onCopyContextMenuText");
  expect(copy).toContain("copy:");
  expect(copy).toContain("복사");
});

test("settings, command palette, automations, right panel, and worker UI are app-server backed", () => {
  const renderer = readUiSources();
  const css = readUiStyleSources();
  const aboutSettings = read(
    "packages/butler-app/client/ui/src/components/settings/AboutSettings.tsx",
  );
  const settingsShell = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsShell/SettingsShell.tsx",
  );
  const settingsShellStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsShell/SettingsShell.module.css",
  );
  const personalizationOptions = read(
    "packages/butler-app/client/ui/src/components/settings/PersonalizationSettingsOptions.ts",
  );

  expect(renderer).toContain("function CommandPalette");
  expect(renderer).toContain("/command-palette?query=");
  expect(renderer).toContain("function SettingsView");
  expect(renderer).toContain("function AboutSettings");
  expect(renderer).toContain('api<AppInfoView>("/app-info")');
  expect(renderer).toContain("setDeveloperMode(enabled)");
  expect(renderer).toContain('data-test-class="about-developer-mode"');
  expect(renderer).toContain("settingsCopy.fields.appRepository");
  expect(aboutSettings).not.toContain("KeyValueRow");
  expect(aboutSettings).toContain("<SettingsField");
  expect(aboutSettings).toContain('controlWidth="full"');
  expect(aboutSettings).toContain("readOnlyValue");
  expect(renderer).toContain("function UpdatesSettings");
  expect(renderer).toContain("/updates/check");
  expect(renderer).toContain("/updates/apply");
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "getUpdates",
  );
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "checkUpdates",
  );
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "applyUpdate",
  );
  expect(renderer).toContain("AppToaster");
  expect(renderer).toContain("notifyError");
  expect(renderer).toContain("notifyLoading");
  expect(renderer).toContain("notifyStatus");
  expect(renderer).toContain('from "sonner"');
  expect(
    read("packages/butler-app/client/ui/src/components/common/AppToaster.tsx"),
  ).toContain("toastClassNames");
  expect(
    read("packages/butler-app/client/ui/src/components/common/AppToaster.tsx"),
  ).toContain('offset={{ top: "var(--titlebar-safe-area-top)" }}');
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/Toast/Toast.ts",
    ),
  ).toContain("success: styles.success");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/Toast/Toast.module.css",
    ),
  ).toContain("var(--color-success-bg)");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/Toast/Toast.module.css",
    ),
  ).toContain("var(--color-success)");
  expect(renderer).toContain('api<SettingsData>("/settings"');
  expect(renderer).toContain('api<ModelCatalogView>("/model-catalog")');
  expect(renderer).toContain("settings-titlebar drag-region");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsDetailHeader.tsx",
    ),
  ).not.toContain("settings-detail-header drag-region");
  expect(renderer).toContain("settings-back-button no-drag");
  expect(settingsShell).toContain("settings-titlebar-drag-overlay");
  expect(settingsShell).toContain("settings-detail-drag-lane");
  expect(settingsShell.indexOf("settings-titlebar-drag-overlay")).toBeGreaterThan(
    settingsShell.indexOf("settings-detail-scroll"),
  );
  expect(settingsShell).toContain('dataTestClass="settings-detail-scroll"');
  expect(settingsShellStyles).toContain(".titlebarDragOverlay");
  expect(settingsShellStyles).toContain("height: var(--titlebar-height)");
  expect(settingsShellStyles).toContain("isolation: isolate");
  expect(settingsShellStyles).toContain("z-index: 100");
  expect(settingsShellStyles).toContain(".detailScroll");
  expect(settingsShellStyles).toContain("z-index: 1");
  expect(settingsShellStyles).toContain("-webkit-app-region: drag");
  const setupWizardShell = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/SetupWizardShell/SetupWizardShell.tsx",
  );
  const setupWizardShellStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/SetupWizardShell/SetupWizardShell.module.css",
  );
  expect(setupWizardShell).toContain('data-test-class="setup-wizard-drag-lane"');
  expect(setupWizardShell).toContain("styles.dragLane");
  expect(setupWizardShell).toContain("className={`${styles.header} drag-region`}");
  expect(setupWizardShellStyles).toContain(".dragLane");
  expect(setupWizardShellStyles).toContain("-webkit-app-region: drag");
  expect(renderer).toContain("closeSettings");
  expect(renderer).toContain("settingsCopy.panels.butlerModel");
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    'butlerModel: "모델 설정"',
  );
  expect(renderer).toContain("settingsFields.contextLimit");
  expect(renderer).toContain("context_window_tokens");
  expect(renderer).toContain("settingsFields.consolidationModel");
  expect(renderer).toContain("consolidation_model");
  expect(renderer).toContain("consolidationModelOptionsFrom");
  expect(renderer).toContain("settingsFields.multilineSend");
  expect(renderer).toContain("modifier_enter_send_enter_newline");
  expect(renderer).toContain("settingsOptions.modifierEnterSendEnterNewline");
  expect(renderer).toContain("settingsFields.personaPreset");
  expect(personalizationOptions).toContain("fields.butlerNickname");
  expect(personalizationOptions).toContain("fields.principalName");
  expect(personalizationOptions).toContain("fields.preferredAddress");
  expect(renderer).toContain("settingsFields.profilingMode");
  expect(renderer).toContain("settingsFields.profilingExtractorModel");
  expect(renderer).toContain("settingsFields.profileMigrationImport");
  expect(renderer).toContain("settingsCopy.actions.openProfileMigration");
  expect(renderer).toContain("settingsCopy.actions.closeProfileMigration");
  expect(renderer).toContain("profileMigrationFeedbackFromResult");
  expect(renderer).toContain("migrationSubmitting");
  expect(renderer).toContain('id: "profile-migration"');
  expect(renderer).toContain("settingsDescriptions.profileMigrationImporting");
  expect(renderer).toContain("settingsDescriptions.profileMigrationImmediate");
  expect(renderer).toContain('data-test-class="profile-migration-status"');
  expect(renderer).toContain('role={migrationFeedback ? "status" : undefined}');
  expect(renderer).toContain("aria-expanded={migrationExpanded}");
  expect(renderer).toContain("<SettingsField");
  expect(renderer).toContain("/personalization/profile-import-prompt?");
  expect(renderer).toContain('"/personalization/profile-import"');
  expect(renderer).not.toContain("migrationSourceOptions");
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    "외부 AI 서비스에서 기억을 가져올 수 있습니다.",
  );
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    "가져오기를 누르면 이 화면에서 바로 처리되며",
  );
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    "다음 답변부터 사용됩니다.",
  );
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).not.toContain(
    "프로필 후보",
  );
  expect(renderer).toContain("copy.actions.clearProfile");
  expect(renderer).toContain("SystemEventsSettings");
  expect(renderer).toContain(
    "`/system-events?limit=${PAGE_SIZE}&offset=${offset}`",
  );
  expect(renderer).toContain("settingsCopy.panels.systemEvents");
  expect(renderer).toContain("UsageSettings");
  expect(renderer).toContain('"/usage-monitor"');
  expect(renderer).toContain("appCopy.settings.panels.usageMonitor");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/UsageSettings.tsx",
    ),
  ).toContain('variant={range === option.id ? "default" : "outline"}');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/UsageSettings.tsx",
    ),
  ).toContain("aria-pressed={range === option.id}");
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "getUsageMonitor",
  );
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    "컨텍스트 창 용량과는 별도로 기록됩니다.",
  );
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    'sessionSync: "대화 기록 반영"',
  );
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    'consolidationModel: "대화 기억 정리 모델"',
  );
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).not.toContain(
    "새벽 정리 모델",
  );
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "listSystemEvents",
  );
  expect(renderer).toContain("selectPersonaPreset");
  expect(renderer).toContain("copy.actions.applyPersonalization");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/PersonalizationActions.tsx",
    ),
  ).toContain("disabled={saving || !hasChanges}");
  expect(personalizationOptions).toContain("description: preset.preview");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsSelect.tsx",
    ),
  ).toContain("selectedHasDescription");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsSelect.tsx",
    ),
  ).toContain('data-slot="select-value-description"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsSelect.tsx",
    ),
  ).toContain("triggerTestClass");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsSelect.tsx",
    ),
  ).toContain('width: "100%"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsSelect.tsx",
    ),
  ).toContain('flex: "0 1 460px"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsSelect.tsx",
    ),
  ).toContain('width: "min(100%, 460px)"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ButlerPrimaryModelSelect.tsx",
    ),
  ).toContain('triggerTestClass="settings-primary-model-select"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ButlerPrimaryModelSelect.tsx",
    ),
  ).toContain('data-test-class="settings-model-management-button"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ButlerPrimaryModelSelect.tsx",
    ),
  ).toContain('size="lg"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ModelAddEditPage.tsx",
    ),
  ).toContain('triggerTestClass="model-add-provider-select"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/HostedModelSelectFields.tsx",
    ),
  ).toContain('triggerTestClass="hosted-model-select"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/HostedCredentialFields.tsx",
    ),
  ).toContain('triggerTestClass="hosted-auth-method-select"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/HostedCredentialFields.tsx",
    ),
  ).toContain("copy.apiBaseUrl");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/useHostedModelForm.ts",
    ),
  ).toContain("api_base_url: apiBaseUrl.trim()");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/useHostedModelForm.ts",
    ),
  ).toContain("apiBaseUrl.trim() !== defaultApiBaseUrl");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ModelAddEditPage.tsx",
    ),
  ).toContain("showProviderSelect={false}");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/modelManagementUtils.ts",
    ),
  ).toContain("provider?.models?.length");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/PersonalizationSettings.tsx",
    ),
  ).toContain('controlWidth="full"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SkillActions.tsx",
    ),
  ).toContain('<ButtonContainer size="sm">');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SkillsSettings.tsx",
    ),
  ).not.toContain("<RowActionCluster>");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/Select/Select.module.css",
    ),
  ).toContain('.trigger[data-multiline="true"]');
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/Select/Select.module.css",
    ),
  ).toContain("font-weight: var(--font-weight-regular)");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsField/SettingsField.module.css",
    ),
  ).toContain('.field[data-control-width="full"] .control');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/PersonalizationProfileMigration.tsx",
    ),
  ).toContain("control={\n          <Button");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/PersonalizationProfileMigration.tsx",
    ),
  ).toContain('id="profile-migration-fields" gap="xl"');
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).not.toContain(
    "예: 테스트 사용자",
  );
  expect(
    read("packages/butler-app/client/ui/src/stores/settingsUIStore.ts"),
  ).toContain("personalizationUpdatePayload");
  expect(
    read("packages/butler-app/client/ui/src/stores/settingsUIStore.ts"),
  ).toContain("editablePersonaText");
  expect(renderer).toContain("function SettingsTokenInput");
  expect(renderer).toContain("settingsFields.localReasoningBudget");
  expect(renderer).toContain("function SettingsPercentInput");
  expect(renderer).toContain("localModelMutationPayload");
  expect(renderer).toContain("settingsCopy.errors.updateLocalReasoningBudget");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsField/SettingsField.module.css",
    ),
  ).toContain("flex-direction: column");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsField/SettingsField.module.css",
    ),
  ).toContain("width: min(100%, 460px)");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsShell/SettingsShell.module.css",
    ),
  ).toContain("grid-template-columns: minmax(220px, 236px) minmax(0, 1fr)");
  expect(renderer).toContain('aria-live="polite"');
  expect(renderer).toContain("aria-describedby={descriptionId}");
  expect(renderer).toContain("settingsDescriptions.contextLimitClamped");
  expect(renderer).toContain("<SettingsShell");
  expect(renderer).toContain("settingsCopy.panels.workerModelRules");
  expect(renderer).toContain("worker_model_rules");
  expect(renderer).toContain("appCopy.settings.localModels");
  expect(renderer).toContain("/model-catalog/local/discover");
  expect(renderer).toContain("api<LocalModelRegistrationResult>(");
  expect(renderer).toContain('"/model-catalog/local-models"');
  expect(renderer).toContain("LocalModelDeletionResult");
  expect(renderer).toContain("copy.saveModel");
  expect(renderer).toContain("copy.deleteLabel(modelDisplayName(model))");
  expect(renderer).toContain("OpenAI-compatible");
  expect(renderer).toContain("llama_cpp");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/LocalModelSettings.tsx",
    ),
  ).toContain("<LocalModelApiSection");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/WorkerModelRule.tsx",
    ),
  ).toContain('data-test-class="worker-model-rule"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/WorkerModelRule.tsx",
    ),
  ).not.toContain("<Grid");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/WorkerModelRule.tsx",
    ),
  ).not.toContain("actions=");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/LocalModelRow.tsx",
    ),
  ).toContain('data-test-class="registered-local-model-row"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsPercentInput.tsx",
    ),
  ).toContain("<Slider");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/LocalModelConfigForm.tsx",
    ),
  ).not.toMatch(/<Slider[\s>]/u);
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/LocalModelConfigForm.tsx",
    ),
  ).toContain("copy.showAdvanced");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/LocalModelConfigForm.tsx",
    ),
  ).not.toContain("copy.provider");
  expect(
    readUiSources("packages/butler-app/client/ui/src/components/settings"),
  ).not.toContain('type="range"');
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "discoverLocalModels",
  );
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "registerLocalModel",
  );
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "updateLocalModel",
  );
  expect(read("packages/butler-app/client/electron/preload.cjs")).toContain(
    "deleteLocalModel",
  );
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsShell/SettingsShell.module.css",
    ),
  ).toContain(".sidebar");
  expect(renderer).not.toContain(":global(.settings-menu-row)");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsView.tsx",
    ),
  ).toContain("SettingsView");
  expect(renderer).toContain("disabled={saving}");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsView.tsx",
    ),
  ).not.toContain("worker_model_presets");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsView.tsx",
    ),
  ).not.toContain("provider-preset");
  expect(renderer).not.toContain("Active settings now");
  expect(renderer).toContain("function AutomationsView");
  expect(renderer).toContain("/automations");
  expect(renderer).toContain("prompt_body");
  expect(renderer).toContain("copy.queued");
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    'title: "자동화"',
  );
  expect(read("packages/butler-app/client/ui/src/app/utils.ts")).toContain(
    "return { title: appCopy.automations.title }",
  );
  expect(read("packages/butler-app/client/ui/src/app/utils.ts")).not.toContain(
    'subtitle: "Butler"',
  );
  expect(renderer).toContain("function Inspector");
  expect(renderer).toContain("/session-view?session_id=");
  expect(renderer).toContain("transcript-export?session_id=");
  expect(renderer).toContain("function WorkerComposerPanel");
  expect(renderer).toContain("function TurnActivityPanel");
  expect(renderer).toContain("function CollapsedTurnActivity");
  expect(renderer).toContain("TurnActivityMessage");
  expect(renderer).toContain("turn-activity-collapsed");
  expect(renderer).toContain("turn-work-panel");
  expect(renderer).toContain("turn-work-collapsed");
  expect(renderer).toContain("turn-result-section");
  expect(renderer).toContain('key="active-turn-activity"');
  expect(renderer).toContain("clientTurnIdFromMessageId");
  expect(renderer).toContain("mergeSessionSummaryForPendingTurn");
  expect(renderer).toContain("safe_progress_rows");
  expect(renderer).toContain("agent.turn_event");
  expect(renderer).toContain("agent.turn_event.progress");
  expect(renderer).toContain("safe_detail_rows");
  expect(renderer).toContain("sendingChatId");
  expect(renderer).toContain("sendingOperations");
  expect(renderer).toContain("Object.values(sendingOperations)");
  expect(renderer).toContain(".includes(activeChatId)");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).not.toContain("setInterval(");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).not.toContain("SESSION_SUMMARY_IDLE_REFRESH_MS");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).toContain("shouldFollowSessionEvents");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).toContain("hasCompleteCachedSession");
  expect(
    read("packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts"),
  ).toContain("if (cursor > 0)");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/conversation/CompletedWorkBlocks.tsx",
    ),
  ).not.toContain("useButlerStore");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/conversation/MessageItem.tsx",
    ),
  ).toContain("export const MessageItem = memo");
  expect(renderer).toContain("showTurnActivity =");
  expect(renderer).toContain("assistant-mark-active");
  expect(renderer).toContain("assistant-mark-static");
  expect(renderer).toContain("<ButlerThinkingMark");
  expect(renderer).toContain("<ButlerMarkIcon");
  expect(renderer).toContain("resolveButlerMarkTheme");
  expect(renderer).toContain("prefers-color-scheme: dark");
  expect(renderer).toContain("function ToolchainDisclosureRow");
  expect(renderer).toContain("function toolchainRowsForBlock");
  expect(renderer).toContain('import { appCopy } from "@/app/copy.ts";');
  expect(renderer).toContain(
    "workCopy.collapsedSummary(primaryLabel, blocks.length)",
  );
  expect(renderer).toContain(
    "aria-label={appCopy.conversation.result.regionLabel}",
  );
  expect(renderer).toContain("appCopy.conversation.work.historyRegionLabel");
  expect(renderer).toContain('export type AppLocale = "en-US" | "ko-KR"');
  expect(renderer).toContain('const defaultAppLocale: AppLocale = "en-US"');
  expect(renderer).toContain('return "ko-KR"');
  expect(renderer).toContain("export function getAppCopy");
  expect(renderer).toContain('historyRegionLabel: "진행 내역"');
  expect(renderer).toContain('regionLabel: "답변"');
  expect(read("package.json")).toContain(
    "packages/butler-app/scripts/lint/app-client-copy-lint.ts",
  );
  expect(
    read("packages/butler-app/scripts/lint/app-client-copy-lint.ts"),
  ).toContain("App client copy lint passed");
  expect(renderer).toContain("controlsId={detailsId}");
  expect(renderer).toContain("open={expanded}");
  expect(renderer).toContain('role="region"');
  expect(renderer).toContain("function activityDetailId");
  expect(renderer).toContain("turn-activity-details");
  expect(renderer).toContain("turn-work-tool-disclosure");
  expect(renderer).toContain("turn-work-tool-detail-list");
  expect(renderer).toContain('row.kind === "message"');
  expect(renderer).toContain("function toolchainLabel");
  expect(renderer).toContain("function toolchainSummaryLabel");
  expect(renderer).toContain("function toolchainGroupLabel");
  expect(renderer).toContain('return row.safe_tool_name ?? row.safe_input_label ?? "Tool"');
  expect(renderer).not.toContain('label.includes("검증")');
  expect(renderer).not.toContain('label.includes("review")');
  expect(renderer).toContain("activityLabel");
  expect(renderer).not.toContain("Using web search:");
  expect(renderer).not.toContain("Running command:");
  expect(renderer).not.toContain("Dispatching:");
  expect(renderer).toContain("Pencil");
  expect(renderer).toContain("Rocket");
  expect(renderer).toContain("ShieldCheck");
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).toContain(
    'codexOauth: "OAuth"',
  );
  expect(read("packages/butler-app/client/ui/src/app/copy.ts")).not.toContain(
    "Codex 브라우저 로그인",
  );
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/RegisteredModelRow.tsx",
    ),
  ).toContain('<Stack gap="xs">');
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/Tag/Tag.module.css",
    ),
  ).toContain("min-height: 20px");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/components/Tag/Tag.module.css",
    ),
  ).toContain("font-size: var(--font-size-1)");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ModelAuthTag.tsx",
    ),
  ).not.toContain("ShieldCheck");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ModelSettingsTitle.tsx",
    ),
  ).toContain("BreadcrumbLink");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ModelSettingsTitle.tsx",
    ),
  ).toContain("ArrowLeft");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/ModelSettingsTitle.tsx",
    ),
  ).toContain('data-test-class="settings-model-route-nav"');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsDetailHeader.tsx",
    ),
  ).toContain("secondary?: ReactNode");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsHeader/SettingsHeader.tsx",
    ),
  ).toContain("secondary?: ReactNode");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsHeader/SettingsHeader.module.css",
    ),
  ).toContain("min-height: 28px");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/settings/SettingsView.tsx",
    ),
  ).toContain("resetModelRoute");
  expect(renderer).toContain("ShieldQuestion");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/conversation/Conversation.tsx",
    ),
  ).not.toContain('status.tone === "error"');
  expect(renderer).toContain("worker-activity/");
  expect(renderer).not.toContain("Voice");
  expect(renderer).not.toContain('<IconButton label="Run"><Play');
  expect(renderer).not.toContain('<IconButton label="Files"><Folder');
  expect(renderer).not.toContain("macOS Tahoe design system foundation");
  expect(renderer).not.toContain("Electron security hardening");
  expect(css).toContain(".palette");
  expect(css).toContain(".shell");
  expect(css).toContain(".trigger");
  expect(css).toContain(".panel");
  expect(css).toContain(".donut");
  expect(css).toContain("@keyframes dialog-open");
  expect(css).toContain("background: var(--composer-glass-bg)");
  const conversation = read(
    "packages/butler-app/client/ui/src/components/conversation/Conversation.tsx",
  );
  for (const forbidden of [
    '"작업"',
    '"결과"',
    '"요청을 처리하고 있습니다."',
    '"작업 내역 열기"',
    '"작업 내역 닫기"',
  ]) {
    expect(conversation).not.toContain(forbidden);
  }
  expect(renderer).toContain("accessModeIcon(accessMode, 16)");
  expect(renderer).toContain("accessModeStyle(accessMode)");
  expect(
    read(
      "packages/butler-app/client/ui/src/components/conversation/accessModeUtils.tsx",
    ),
  ).toContain('"--option-menu-icon-color": iconColorToken');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/conversation/accessModeUtils.tsx",
    ),
  ).toContain('"--composer-control-icon-color": iconColorToken');
  expect(
    read(
      "packages/butler-app/client/ui/src/components/conversation/accessModeUtils.tsx",
    ),
  ).toContain('return "--access-read-icon"');
  const optionMenuCss = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/OptionMenu/OptionMenu.module.css",
  );
  expect(optionMenuCss).toMatch(
    /\.icon\s*\{[\s\S]*color:\s*var\(--option-menu-icon-color, currentColor\);/,
  );
  expect(optionMenuCss).toContain("stroke: currentColor");
  const composerControlCss = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerControl/ComposerControl.module.css",
  );
  expect(composerControlCss).toContain(
    "color: var(--composer-control-icon-color, currentColor)",
  );
  expect(composerControlCss).toContain("stroke: currentColor");
  expect(optionMenuCss).toMatch(
    /\.label\s*\{[\s\S]*color:\s*var\(--text-primary\);/,
  );
  expect(renderer).toContain("function ComposerControlButton");
  expect(renderer).toContain('data-test-class="composer-control-icon"');
  expect(renderer).toContain('data-test-class="composer-control-label"');
  expect(renderer).toContain('data-test-class="composer-model-name"');
  expect(renderer).toContain('data-test-class="composer-model-summary"');
  expect(renderer).toContain("reasoningBudgetSummary(activeModel, reasoning)");
  expect(renderer).toContain("DisclosureRow");
  expect(css).toMatch(
    /\.planToggle\s*\{[\s\S]*border-radius:\s*var\(--radius-pill\);/,
  );
  expect(css).toMatch(
    /\.button\s*\{[\s\S]*border-radius:\s*var\(--radius-pill\);/,
  );
  expect(css).toContain('.switch[data-state="checked"]');
  expect(
    read("packages/butler-app/client/ui/src/libs/design-system/tokens.css"),
  ).toContain("--radius-pill: 999px");
  expect(
    read("packages/butler-app/client/ui/src/libs/design-system/tokens.css"),
  ).toContain("--access-read: var(--text-primary)");
  expect(
    read("packages/butler-app/client/ui/src/libs/design-system/tokens.css"),
  ).toContain("--access-read-icon: var(--text-tertiary)");
  expect(css).toContain(".donut");
  expect(renderer).toContain("<ContextDonutButton");
  expect(css).toContain("border: 1px solid var(--composer-glass-border)");
  expect(css).toContain("backdrop-filter: var(--composer-glass-filter)");
  expect(css).toContain("background: transparent");
  expect(css).not.toContain("background: var(--composer-glass-glint)");
  expect(css).not.toContain("--composer-glass-glint: linear-gradient");
  expect(css).not.toContain("inset 0 -1px 0 var(--composer-glass-lowlight)");
  expect(css).not.toContain(
    "box-shadow: inset 0 1px 0 var(--composer-glass-highlight);",
  );
  expect(renderer).toContain("<ProgressMeter");
});

test("app client enforces tokenized styling and modular store architecture", () => {
  const rootPackage = JSON.parse(read("package.json"));
  const designLint = read(
    "packages/butler-app/scripts/lint/design-token-lint.ts",
  );
  const cssGlobalLint = read(
    "packages/butler-app/scripts/lint/css-module-global-lint.ts",
  );
  const renderer = readUiSources();
  const settingsSource = readUiSources(
    "packages/butler-app/client/ui/src/components/settings",
  );
  const settingsShellCss = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsShell/SettingsShell.module.css",
  );

  expect(rootPackage.scripts.lint).toContain("lint:design");
  expect(rootPackage.scripts["lint:design"]).toContain("design-token-lint.ts");
  expect(rootPackage.scripts["lint:design"]).toContain(
    "component-line-count-lint.ts",
  );
  expect(rootPackage.scripts["lint:design"]).toContain(
    "css-module-global-lint.ts",
  );
  expect(rootPackage.scripts["lint:design"]).toContain("prop-boundary-lint.ts");
  expect(designLint).toContain(
    "raw color value must be promoted to a design token",
  );
  expect(designLint).toContain(
    "raw typography value must use design-system typography tokens",
  );
  expect(designLint).toContain(
    "raw color utility class must be replaced by token-backed styling",
  );
  expect(designLint).toContain(
    "raw hex color in tokens.css must live in a source palette token",
  );
  expect(designLint).toContain("isSourceColorTokenName");
  expect(designLint).toContain("inCssVariableDefinition");
  expect(designLint).toContain("stripCssCommentsFromLine");
  expect(cssGlobalLint).toContain(":global selector in component CSS module");
  expect(cssGlobalLint).not.toContain("top-level :global");
  for (const file of listUiSourceFiles(
    "packages/butler-app/client/ui/src/components",
  )) {
    if (
      file.endsWith(".module.css") &&
      !file.includes("/libs/design-system/shadcn/")
    ) {
      const cssModule = read(file);
      if (cssModule.includes(":global")) {
        throw new Error(`${file} should not use component-owned :global`);
      }
    }
  }
  expect(settingsShellCss).not.toContain("settings-field");
  expect(settingsShellCss).not.toContain("worker-model-rule");
  expect(settingsShellCss).not.toContain("section-nav");
  expect(renderer).toContain("export const useSettingsUIStore = create");
  expect(settingsSource).not.toContain("SettingsContext");
  expect(settingsSource).not.toContain("createContext");
  expect(renderer).toContain("export const useButlerStore = create");
  expect(renderer).toContain("export function useAppBootstrap");
  expect(renderer).toContain("export function AppShell");
  expect(renderer).toContain("export function Conversation");
  expect(renderer).toContain("export function SettingsView");
  expect(renderer).toContain("export function SidebarItem");
  expect(renderer).toContain("export function Tooltip");
  expect(renderer).toContain("export function usePortalThemeClasses");
  expect(renderer).toContain("const activePortalThemes = new Map");
  expect(renderer).toContain("function syncPortalThemeClasses");
  expect(renderer).toContain('role="tooltip"');
  expect(renderer).toContain("aria-describedby");
  expect(renderer).toContain("cloneElement");
  expect(renderer).toContain("TOOLTIP_DELAY_MS");
  expect(renderer).toContain("TOOLTIP_FALLBACK_HEIGHT_PX");
  expect(renderer).toContain("TITLEBAR_SAFE_AREA_TOP_PX");
  expect(renderer).toContain("composeRefs");
  expect(renderer).toContain("title={undefined}");
  expect(renderer).toContain("function SidebarProjectGroup");
  expect(renderer).toContain("function SidebarProjectSessionItem");
  expect(renderer).toContain("function SidebarDirectItem");
  expect(renderer).toContain("function SidebarChatItem");
  expect(renderer).toContain("function SidebarSection");
  expect(renderer).toContain("function SidebarSettingsItem");
  expect(renderer).toContain("function SidebarProjectsMenu");
  expect(renderer).toContain("function SidebarProjectActions");
  expect(renderer).toContain("function SidebarSessionActions");
  expect(renderer).toContain("function useSidebarProjectCollapse");
  expect(renderer).toContain('rightVisibility="hover"');
  expect(renderer).toContain('aria-current={active ? "page" : undefined}');
  expect(renderer).toContain('aria-hidden="true">{icon}</span>');
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavRow/NavRow.module.css",
    ),
  ).not.toContain("box-shadow: inset 2px 0 0 var(--accent)");
  expect(renderer).toContain('state.view.kind === "session"');
  expect(renderer).toContain("state.activeChatId === session.id");
  expect(renderer).not.toContain(
    "sessions.some((session) => session.id === activeChatId)",
  );
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/CollapsibleNavGroup/CollapsibleNavGroup.module.css",
    ),
  ).not.toContain("margin-left: 24px");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavRow/NavRow.module.css",
    ),
  ).toContain("grid-template-columns: minmax(0, 1fr) auto");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavRow/NavRow.module.css",
    ),
  ).toContain(".labelRegion");
  expect(
    read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/NavRow/NavRow.module.css",
    ),
  ).toContain(".controlRegion");
  expect(
    read("packages/butler-app/client/ui/src/libs/design-system/tokens.css"),
  ).toContain("--sidebar-row-height");
  expect(
    read("packages/butler-app/client/ui/src/libs/design-system/tokens.css"),
  ).toContain("--font-weight-regular");
  expect(
    read("packages/butler-app/client/ui/src/libs/design-system/tokens.css"),
  ).toContain("--text-tertiary: var(--color-text-tertiary)");
  expect(
    read("packages/butler-app/client/ui/src/libs/design-system/tokens.css"),
  ).toContain("--context-chart-1: var(--accent)");
  expect(designLint).toContain("font-weight");
  expect(renderer).not.toMatch(/\bany\b/);
  expect(renderer).not.toContain("bg-black/10");
});

test("layout smoke captures real browser screenshots instead of placeholder images", () => {
  const smoke = read("tests/smoke/app-layout-smoke.ts");
  const hmrSmoke = read("packages/butler-app/scripts/app-ui-hmr-smoke.ts");
  const devScript = read("packages/butler-app/scripts/app-client-dev.ts");
  const managedServerSmoke = read(
    "packages/butler-app/scripts/app-client-managed-server-smoke.ts",
  );
  const modelManagementE2e = read("tests/e2e/app-model-management-e2e.ts");
  const electronMain = read("packages/butler-app/client/electron/main.mjs");

  expect(smoke).toContain('from "playwright"');
  expect(smoke).toContain("?visual=components");
  expect(read("tests/smoke/app-design-system-smoke.ts")).toContain(
    "?visual=design-system",
  );
  expect(smoke).toContain("page.screenshot");
  expect(smoke).toContain("conversation-body-width-matches-composer");
  expect(smoke).toContain("user-bubble-content-sized");
  expect(smoke).toContain("assistant-footer-copy-duration-time");
  expect(smoke).toContain("assistant-footer-semantic-time");
  expect(smoke).toContain("composer-ready-status-absent");
  expect(smoke).toContain("context-hover-popover-visible");
  expect(smoke).toContain("context-popover-titlebar-safe");
  expect(smoke).toContain("tooltip-reappears-after-second-hover");
  expect(smoke).toContain("tooltip-titlebar-safe");
  expect(smoke).toContain("right-panel-toggle-tooltip-horizontal");
  expect(smoke).toContain("titlebar-tooltip-focus-restore-suppressed");
  expect(smoke).toContain("popover-liquid-glass-tokenized");
  expect(smoke).toContain("select-liquid-glass-tokenized");
  expect(smoke).toContain("dialog-content-titlebar-safe");
  expect(smoke).toContain("titlebar-menu-content-titlebar-safe");
  expect(smoke).toContain("tooltip-theme-tokenized");
  expect(smoke).toContain("dark-titlebar-text-tokenized");
  expect(smoke).toContain("light-titlebar-text-tokenized");
  expect(smoke).toContain("pending-turn-does-not-flash-stale-tool-history");
  expect(smoke).toContain("context-detail-chart-visible");
  expect(smoke).toContain("context-legend-swatch-label-aligned");
  expect(smoke).toContain("context-legend-scrolls");
  expect(smoke).toContain("context-legend-scrollbar-gutter");
  expect(smoke).toContain("context-legend-content-aligns-overview");
  expect(smoke).toContain("summary-progress-inspector-bounded");
  expect(smoke).toContain("settings-detail-drag-after-scroll");
  expect(smoke).toContain("settings-main-theme-options");
  expect(smoke).toContain("settings-main-theme-silk-option");
  expect(smoke).toContain("settings-silk-theme-detail-absent");
  expect(smoke).toContain("settings-bloom-colors-circular");
  expect(smoke).toContain("new-chat-silk-fluid-visible");
  expect(smoke).toContain("new-chat-vertical-scroll-absent");
  expect(smoke).toContain("new-chat-start-position-high");
  expect(smoke).toContain("new-chat-moment-time-visible");
  expect(smoke).toContain("new-chat-extra-icon-gutter");
  expect(smoke).toContain("new-chat-left-radius-preserved");
  expect(smoke).toContain("browser-chrome-traffic-reserve-zero");
  expect(smoke).toContain("browser-sidebar-toggle-flush-left");
  expect(smoke).toContain("narrow-right-panel-visible");
  expect(smoke).toContain("narrow-right-panel-titlebar-draggable");
  expect(smoke).toContain("sidebar should collapse to 0px");
  expect(smoke).toContain("sidebar-hover-highlight");
  expect(smoke).toContain("light-theme-sidebar-tokenized");
  expect(smoke).toContain("permission-trigger-no-chevron");
  expect(smoke).toContain("plan-switch-absent");
  expect(smoke).toContain("cmd-enter-blocks-during-composition");
  expect(smoke).toContain("cmd-enter-send-optimistic");
  expect(smoke).toContain("turn-activity-during-send");
  expect(smoke).toContain('data-test-class~="${name}"');
  expect(smoke).toContain('testClass("composer-wrap")');
  expect(smoke).toContain('testClass("turn-activity-panel")');
  expect(smoke).toContain(
    'testClasses("message", "assistant", "turn-activity-message")',
  );
  expect(smoke).toContain("markdown-response-rendered");
  expect(smoke).toContain("markdown-inline-image-rendered");
  expect(smoke).toContain("markdown-inline-image-bounded");
  expect(smoke).toContain("conversation-context-menu-liquid-glass-tokenized");
  expect(smoke).toContain("session-row-context-menu-liquid-glass-tokenized");
  expect(smoke).toContain("attachment-picker-visible");
  expect(smoke).toContain("attachment-picker-all-files");
  expect(smoke).toContain("png-attachment-chip");
  expect(smoke).toContain("left-panel-resizes");
  expect(smoke).toContain("right-panel-resizes");
  expect(smoke).toContain("right-panel-toggle-open-ghostless");
  expect(smoke).toContain("right-panel-content-width-stable-while-closing");
  expect(smoke).toContain("left-resize-below-min-collapses");
  expect(smoke).toContain("artifact-detail-opens");
  expect(smoke).toContain("real-app-project-rename-modal");
  expect(smoke).toContain("?visual=thinking-mark");
  expect(smoke).toContain("thinking-mark-state-toggle");
  expect(smoke).toContain("thinking-mark-resizable");
  expect(smoke).toContain("thinking-mark-svg-icon");
  expect(smoke).toContain("right panel toggle should be hidden on settings");
  expect(smoke).not.toContain("writeSmokePng");
  expect(smoke).not.toContain("onePixelTransparentPng");
  expect(hmrSmoke).toContain("--butler-hmr-smoke");
  expect(hmrSmoke).toContain("css-module-hmr-applied");
  expect(hmrSmoke).toContain("css-module-hmr-removed");
  expect(devScript).toContain("BUTLER_APP_UI_URL");
  expect(devScript).toContain("BUTLER_APP_SERVER_PORT");
  expect(devScript).toContain("BUTLER_APP_SERVER_URL");
  expect(devScript).toContain('new URL("/health", serverUrl)');
  expect(devScript).toContain("--strictPort");
  expect(devScript).toContain("prepareMacDevElectronBundle");
  expect(devScript).toContain("Electron.app");
  expect(devScript).toContain("Butler.app");
  expect(devScript).toContain("Contents/MacOS/Butler");
  expect(devScript).toContain("CFBundleDisplayName");
  expect(devScript).toContain("CFBundleName");
  expect(devScript).toContain("CFBundleExecutable");
  expect(devScript).toContain("CFBundleIdentifier");
  expect(devScript).toContain("CFBundleIconFile");
  expect(devScript).toContain("CFBundleIconName");
  expect(devScript).toContain("assets/butler.icns");
  expect(devScript).toContain("Contents/Resources/butler.icns");
  expect(devScript).toContain("com.hexpy.butler.dev");
  expect(devScript).toContain("/usr/libexec/PlistBuddy");
  expect(devScript).toContain("/usr/bin/codesign");
  expect(devScript).toContain("spawnManaged(electronLaunch.command");
  expect(managedServerSmoke).toContain("managed-app-server-healthy");
  expect(managedServerSmoke).toContain("single-slash-health-url");
  expect(managedServerSmoke).toContain("BUTLER_APP_SERVER_BRIDGE");
  expect(modelManagementE2e).toContain("Model management E2E passed");
  expect(modelManagementE2e).toContain("xAI / Grok");
  expect(modelManagementE2e).toContain("Qwen Cloud");
  expect(modelManagementE2e).toContain("Moonshot / Kimi");
  expect(modelManagementE2e).toContain("Z.AI / GLM");
  expect(electronMain).toContain("findAvailablePort");
  expect(electronMain).toContain("syncPreloadServerEnvironment");
  expect(electronMain).toContain("createBundledAgentSupervisor");
});

test("thinking mark components expose state and theme contracts", () => {
  const canvasMark = read(
    "packages/butler-app/client/ui/src/components/common/ButlerThinkingMark.tsx",
  );
  const svgIcon = read(
    "packages/butler-app/client/ui/src/components/common/ButlerMarkIcon.tsx",
  );
  const svgAsset = read(
    "packages/butler-app/client/ui/src/components/common/butler-mark.svg",
  );
  const theme = read(
    "packages/butler-app/client/ui/src/components/common/butlerMarkTheme.ts",
  );
  const harness = read(
    "packages/butler-app/client/ui/src/pages/ThinkingMarkHarness.tsx",
  );

  expect(theme).toContain('export type ButlerMarkTheme = "dark" | "light"');
  expect(theme).toContain("export type ButlerMarkThemeColors");
  expect(theme).toContain("inkForButlerMarkTheme");
  expect(canvasMark).toContain(
    'export type ButlerThinkingMarkState = "idle" | "working"',
  );
  expect(canvasMark).toContain("state?: ButlerThinkingMarkState");
  expect(canvasMark).toContain("theme?: ButlerMarkTheme");
  expect(canvasMark).toContain("themeColors?: ButlerMarkThemeColors");
  expect(canvasMark).toContain("variant?: ButlerThinkingMarkVariant");
  expect(canvasMark).toContain("ctx.setTransform(pixelSide / DESIGN_SIZE");
  expect(canvasMark).toContain('canvas.getContext("2d", { alpha: true })');
  expect(canvasMark).toContain("1000 / 60");
  expect(svgIcon).toContain('viewBox="0 0 1200 1200"');
  expect(svgIcon).toContain("theme?: ButlerMarkTheme");
  expect(svgIcon).toContain("themeColors?: ButlerMarkThemeColors");
  expect(svgIcon).toContain("inkForButlerMarkTheme");
  expect(svgIcon).toContain('replace(/:/gu, "-")');
  expect(svgIcon).toContain('r="406"');
  expect(svgIcon).toContain("A329.43 329.43");
  expect(svgIcon).not.toContain("A136 136");
  expect(svgAsset).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  expect(svgAsset).toContain('viewBox="0 0 1200 1200"');
  expect(svgAsset).toContain('aria-label="Butler"');
  expect(svgAsset).toContain('stroke="currentColor"');
  expect(svgAsset).toContain('clip-path="url(#butler-mark-idle-clip)"');
  expect(svgAsset).toContain('r="406"');
  expect(svgAsset).toContain("A329.43 329.43");
  expect(svgAsset).not.toContain("A136 136");
  expect(harness).toContain("<ButlerMarkIcon");
  expect(harness).toContain("state={markState}");
  expect(harness).toContain('theme="dark"');
  expect(harness).toContain('theme="light"');
});

test("active turn fallback copy matches the turn state", () => {
  const copy = read("packages/butler-app/client/ui/src/app/copy.ts");
  const panel = read(
    "packages/butler-app/client/ui/src/components/conversation/TurnActivityPanel.tsx",
  );

  expect(copy).toContain("pendingStateLabels");
  expect(copy).toContain('session_starting: "새 세션 시작중..."');
  expect(copy).toContain('thinking: "생각 중입니다."');
  expect(copy).toContain('streaming: "응답을 작성하고 있습니다."');
  expect(panel).toContain('const SESSION_STARTING_STATE = "session_starting"');
  expect(panel).toContain("<Skeleton");
  expect(panel).toContain("turnActivityPendingLabel(state)");
  expect(panel).toContain('data-turn-state={state ?? "unknown"}');
  expect(panel).not.toContain("{appCopy.conversation.work.pendingLabel}");
});

test("design system exposes a skeleton primitive for loading shells", () => {
  const rootIndex = read(
    "packages/butler-app/client/ui/src/libs/design-system/index.ts",
  );
  const registry = read(
    "packages/butler-app/client/ui/src/libs/design-system/registry.tsx",
  );
  const skeleton = read(
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/skeleton.tsx",
  );
  const skeletonCss = read(
    "packages/butler-app/client/ui/src/libs/design-system/components/Skeleton/Skeleton.module.css",
  );

  expect(rootIndex).toContain('export * from "./components/Skeleton"');
  expect(registry).toContain('name: "Skeleton"');
  expect(skeleton).toContain('data-slot="skeleton"');
  expect(skeleton).toContain('role={label ? "status" : undefined}');
  expect(skeletonCss).toContain("@keyframes skeleton-shimmer");
  expect(skeletonCss).toContain("var(--surface-raised)");
});

test("app client production component structure enforces boundary rules", () => {
  // UI primitive composition-pattern files that are explicitly allowed to have
  // multiple small components in one file
  const compositionPrimitiveExceptions = [
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/dropdown-menu.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/select.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/dialog.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/field.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/breadcrumb.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/tabs.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/context-menu.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/popover.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/native-select.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/chart.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/button.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/tooltip.tsx",
    "packages/butler-app/client/ui/src/components/common/Display.tsx",
    "packages/butler-app/client/ui/src/libs/design-system/components/Typo.tsx",
  ];

  const componentFiles = listUiSourceFiles()
    .filter(
      (file) =>
        file.match(/\.tsx?$/u) &&
        file.includes("/components/") &&
        !file.includes(".module.css") &&
        !file.includes(".test.") &&
        !file.includes(".spec.") &&
        !file.includes("/hooks/") &&
        !/\/use[A-Z][A-Za-z0-9]*\.tsx?$/u.test(file),
    )
    .filter((file) => !compositionPrimitiveExceptions.includes(file));

  const violations: Array<{
    file: string;
    issue: string;
    lineCount?: number;
  }> = [];

  for (const file of componentFiles) {
    const content = read(file);
    const lines = content.split("\n");

    // Check for >160 line production components
    if (lines.length > 160) {
      violations.push({
        file,
        issue: "Production component exceeds 160 lines",
        lineCount: lines.length,
      });
    }

    // Check for multiple exported components in one file
    const exportedComponentMatches = content.match(
      /export\s+(?:function|const)\s+([A-Z][A-Za-z0-9]*)\s*[(:]/gu,
    );
    const exportedComponents = exportedComponentMatches
      ? exportedComponentMatches
          .map((match) => match.match(/([A-Z][A-Za-z0-9]*)/u)?.[1])
          .filter(Boolean)
      : [];

    // Filter out obvious non-component exports (types, constants, utilities)
    const likelyComponents = exportedComponents.filter(
      (name) =>
        name &&
        !name.endsWith("Props") &&
        !name.endsWith("Type") &&
        !name.endsWith("Config") &&
        !name.startsWith("use") &&
        !name.match(/^[A-Z_]+$/u), // All caps are constants
    );

    if (likelyComponents.length > 1) {
      violations.push({
        file,
        issue: `Multiple production components in one file: ${likelyComponents.join(", ")}`,
      });
    }
  }

  // Report violations
  if (violations.length > 0) {
    const report = violations
      .map(
        (violation) =>
          `${violation.file}: ${violation.issue}${
            violation.lineCount ? ` (${violation.lineCount} lines)` : ""
          }`,
      )
      .join("\n");
    throw new Error(
      `Production component structure violations found:\n${report}`,
    );
  }
});

test("composer controls use a store boundary instead of toolbar props drilling", () => {
  const composer = read(
    "packages/butler-app/client/ui/src/components/conversation/Composer.tsx",
  );
  const toolbar = read(
    "packages/butler-app/client/ui/src/components/conversation/ComposerToolbar.tsx",
  );
  const store = read(
    "packages/butler-app/client/ui/src/components/conversation/composerStore.ts",
  );

  expect(toolbar).toContain("useComposerStore");
  expect(toolbar).not.toContain("interface ComposerToolbarProps");
  expect(toolbar).not.toContain("fileInputRef:");
  expect(toolbar).not.toContain("setAccessMenuOpen:");
  expect(toolbar).not.toContain("onModelChoice:");
  expect(toolbar).not.toContain("onReasoningChange:");
  expect(toolbar).not.toContain("onPlanModeChange:");
  expect(toolbar).not.toContain("ComposerPlanToggle");
  expect(toolbar).not.toContain("planMode");
  expect(toolbar).not.toContain("handlePlanModeChange");
  expect(toolbar).not.toContain("appCopy.composer.plan");
  expect(composer).toContain("<ComposerToolbar />");
  expect(composer).not.toContain("accessMode={");
  expect(composer).not.toContain("setAccessMenuOpen={");
  expect(composer).not.toContain("onModelChoice={");
  expect(store).toContain('from "zustand"');
  expect(store).toContain("setSnapshot");
  expect(store).toContain("submit");
  expect(store).toContain("handleModelChoice");
});

test("composer adjunct panels use design-system blocks inside the composer card", () => {
  const composerCard = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerCard/ComposerCard.tsx",
  );
  const composerCardStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerCard/ComposerCard.module.css",
  );
  const normalizedComposerCardStyles = collapseWhitespace(composerCardStyles);
  const workerPanel = read(
    "packages/butler-app/client/ui/src/components/conversation/WorkerComposerPanel.tsx",
  );
  const todoPanel = read(
    "packages/butler-app/client/ui/src/components/conversation/TodoComposerPanel.tsx",
  );
  const workerPanelFixture = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkerActivityPanel/WorkerActivityPanel.fixtures.tsx",
  );
  const todoPanelFixture = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/TodoProgressPanel/TodoProgressPanel.fixtures.tsx",
  );
  const todoProgressPanel = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/TodoProgressPanel/TodoProgressPanel.tsx",
  );
  const todoProgressPanelStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/TodoProgressPanel/TodoProgressPanel.module.css",
  );
  const workerActivityPanel = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkerActivityPanel/WorkerActivityPanel.tsx",
  );
  const workerActivityRow = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkerActivityRow/WorkerActivityRow.tsx",
  );
  const workerActivityRowStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkerActivityRow/WorkerActivityRow.module.css",
  );
  const composerAdjunctPanel = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerAdjunctPanel/ComposerAdjunctPanel.tsx",
  );
  const composerAdjunctPanelStyles = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ComposerAdjunctPanel/ComposerAdjunctPanel.module.css",
  );
  const bootstrap = read(
    "packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts",
  );

  expect(composerCard).toContain("styles.adjunct");
  expect(composerCard).toContain("tintedGlassSurfaceClassName");
  expect(composerCard).toContain('data-radius="composer"');
  expect(composerCard).toContain('data-test-class="composer-adjunct-slot"');
  expect(composerCard.indexOf("{adjunct ?")).toBeGreaterThan(
    composerCard.indexOf("<form"),
  );
  expect(composerCardStyles).toContain(".adjunct");
  expect(composerCardStyles).toContain("border-bottom");
  expect(composerCardStyles).not.toContain("--composer-glass-glint");
  expect(normalizedComposerCardStyles).toContain(
    ".adjunct { min-width: 0; border-bottom: 1px solid var(--composer-glass-divider); padding: 0;",
  );
  expect(
    normalizedComposerCardStyles.match(
      /padding: var\(--composer-inner-padding-block\) var\(--composer-inner-padding-inline\);/g,
    )?.length,
  ).toBe(1);
  expect(normalizedComposerCardStyles).toContain(
    ".toolbar { display: flex; min-height: 42px; align-items: center; gap: var(--space-1); border-top: 1px solid var(--composer-glass-divider); padding: var(--space-2);",
  );
  expect(workerPanel).toContain("WorkerActivityPanel");
  expect(workerPanel).not.toContain("ActivityFeed");
  expect(workerPanel).toContain("phase: worker.semantic_phase ?? worker.phase");
  expect(workerPanel).toContain("workerCollapsedSummary(");
  expect(workerPanel).toContain("collapsedSummary={collapsedSummary}");
  expect(todoPanel).toContain("TodoProgressPanel");
  expect(workerPanelFixture).toContain("<ComposerCard");
  expect(workerPanelFixture).toContain("adjunct={");
  expect(workerPanelFixture).toContain("<WorkerActivityPanel");
  expect(workerPanelFixture).toContain("collapsedSummary=");
  expect(todoPanelFixture).toContain("<ComposerCard");
  expect(todoPanelFixture).toContain("adjunct={");
  expect(todoPanelFixture).toContain("<TodoProgressPanel");
  expect(todoProgressPanel).not.toContain("SurfacePanel");
  expect(todoProgressPanel).toContain("ComposerAdjunctPanel");
  expect(todoProgressPanel).toContain("currentItem");
  expect(todoProgressPanel).toContain("collapsedSummary");
  expect(todoProgressPanel).not.toContain("PanelSectionTitle");
  expect(workerActivityPanel).toContain("ComposerAdjunctPanel");
  expect(workerActivityPanel).toContain("collapsedSummary?: ReactNode");
  expect(workerActivityPanel).toContain("collapsedSummary={collapsedSummary}");
  expect(workerActivityPanel).not.toContain("PanelSectionTitle");
  expect(workerActivityRow).toContain("styles.primaryLine");
  expect(workerActivityRow).toContain("styles.phaseRail");
  expect(workerActivityRow).not.toContain("</div>\n        {description ? (");
  expect(workerActivityRowStyles).toContain(
    "grid-template-columns: minmax(0, 1fr) auto;",
  );
  expect(workerActivityRowStyles).toContain("white-space: nowrap;");
  expect(workerActivityRow).toContain('data-slot="activity-feed-meta"');
  expect(workerActivityRow).toContain('data-slot="activity-feed-description"');
  expect(workerActivityRowStyles).toContain("flex: 0 0 auto;");
  expect(workerActivityRowStyles).toContain("flex: 1 1 auto;");
  expect(workerActivityRowStyles).toContain("min-width: max-content;");
  expect(workerActivityRowStyles).toContain(
    "font-weight: var(--font-weight-regular);",
  );
  expect(composerAdjunctPanel).toContain("collapsedSummary?: ReactNode");
  expect(composerAdjunctPanel).toContain("useState(defaultCollapsed)");
  expect(composerAdjunctPanel).toContain("aria-expanded={!collapsed}");
  expect(composerAdjunctPanel).toContain(
    'data-collapsed={collapsed ? "true" : "false"}',
  );
  expect(composerAdjunctPanel).toContain("data-has-summary");
  expect(composerAdjunctPanel).toContain("collapsed && collapsedSummary");
  expect(composerAdjunctPanel).toContain("aria-hidden={collapsed}");
  expect(composerAdjunctPanel).toContain("styles.bodyInner");
  expect(composerAdjunctPanel).not.toContain("\n        hidden={collapsed}");
  expect(composerAdjunctPanel).not.toContain("ChevronRight");
  expect(composerAdjunctPanel).toContain("ChevronDown");
  expect(composerAdjunctPanel).toContain('Typo.Body as="span"');
  expect(composerAdjunctPanelStyles).toContain("border-bottom");
  expect(composerAdjunctPanelStyles).toContain("opacity: 0.68");
  expect(composerAdjunctPanelStyles).toContain("cursor: pointer");
  expect(composerAdjunctPanelStyles).toContain(".summary");
  expect(composerAdjunctPanelStyles).toContain("transition:");
  expect(composerAdjunctPanelStyles).toContain(
    '.chevron[data-collapsed="true"]',
  );
  expect(composerAdjunctPanelStyles).toContain("grid-template-rows: 1fr");
  expect(composerAdjunctPanelStyles).toContain('.body[data-collapsed="true"]');
  expect(composerAdjunctPanelStyles).toContain("grid-template-rows: 0fr");
  expect(composerAdjunctPanelStyles).toContain(".bodyInner");
  expect(composerAdjunctPanelStyles).toContain("prefers-reduced-motion");
  expect(composerAdjunctPanelStyles).not.toContain(".body[hidden]");
  expect(composerAdjunctPanelStyles).toContain(
    "padding: var(--space-2) var(--composer-inner-padding-inline)",
  );
  expect(todoProgressPanelStyles).not.toContain("box-shadow");
  expect(todoProgressPanelStyles).not.toContain("background:");
  expect(todoProgressPanelStyles).not.toContain("border:");
  expect(bootstrap).toContain("activeWorkerVisible");
  expect(bootstrap).toContain("hasFollowableWorkerActivity(data.workers)");
});

describe("app-client design system foundation", () => {
  const appClientPath = join(root, "packages/butler-app/client/ui");
  const designSystemRoot = join(appClientPath, "src/libs/design-system");
  const designSystemPath = join(designSystemRoot, "components");
  const designSystemBlocksPath = join(designSystemRoot, "blocks");
  const blockNames = [
    "NavRow",
    "NavSection",
    "CollapsibleNavGroup",
    "RowActionCluster",
    "OverflowActionMenu",
    "FormRow",
    "FormSection",
    "PanelHeader",
    "PromptSuggestionList",
    "SurfacePanel",
    "MetricCard",
    "MetricGrid",
    "CardList",
    "ListRow",
    "ResourceSummary",
    "ResourceTile",
    "EmptyLine",
    "Notice",
    "ComposerControl",
    "ComposerAdjunctPanel",
    "ComposerQueuePanel",
    "AttachmentList",
    "MessageAvatarBlock",
    "ActivityFeed",
    "DisclosureRow",
    "InspectorPanel",
    "KeyValueRow",
    "ProgressMeter",
    "TodoProgressPanel",
    "WorkerActivityPanel",
    "WorkerActivityRow",
    "SettingsField",
    "SettingsHeader",
    "SettingsNav",
    "SettingsSecretRows",
    "TokenInputControl",
    "PercentInputControl",
    "ManagementPage",
    "DashboardHeader",
    "DocumentTile",
    "SessionRow",
    "AutomationRow",
    "AutomationRunList",
    "ArtifactList",
    "ArtifactPreview",
    "ScrollArea",
    "CommandPanel",
    "DialogForm",
    "ChromeFrame",
    "TitlebarShell",
  ];
  const componentPath = (name: string, file: string) =>
    join(designSystemPath, name, file);
  const blockPath = (name: string, file: string) =>
    join(designSystemBlocksPath, name, file);

  test("design-system component files exist", () => {
    for (const name of [
      "Typo",
      "Stack",
      "Grid",
      "Section",
      "Space",
      "Button",
      "ButtonContainer",
      "TintedGlass",
    ]) {
      expect(existsSync(componentPath(name, `${name}.tsx`))).toBe(true);
      expect(existsSync(componentPath(name, `${name}.module.css`))).toBe(true);
      expect(existsSync(componentPath(name, `${name}.fixtures.tsx`))).toBe(
        true,
      );
      expect(existsSync(componentPath(name, "README.md"))).toBe(true);
      expect(existsSync(componentPath(name, "index.ts"))).toBe(true);
    }
    expect(existsSync(join(designSystemRoot, "index.ts"))).toBe(true);
    expect(existsSync(join(designSystemRoot, "registry.tsx"))).toBe(true);
    expect(existsSync(join(designSystemRoot, "tokens.css"))).toBe(true);
  });

  test("design-system exports are consumed", () => {
    const indexContent = readFileSync(
      join(designSystemRoot, "index.ts"),
      "utf8",
    );
    const buttonContainer = readFileSync(
      componentPath("ButtonContainer", "ButtonContainer.tsx"),
      "utf8",
    );
    expect(indexContent).toContain('export * from "./components/Stack"');
    expect(indexContent).toContain('export * from "./components/Grid"');
    expect(indexContent).toContain('export * from "./components/Section"');
    expect(indexContent).toContain('export * from "./components/Space"');
    expect(indexContent).toContain('export * from "./components/Button"');
    expect(indexContent).toContain(
      'export * from "./components/ButtonContainer"',
    );
    expect(indexContent).toContain('export * from "./components/Card"');
    expect(indexContent).toContain('export * from "./components/TintedGlass"');
    expect(indexContent).toContain('export * from "./blocks/NavRow"');
    expect(indexContent).toContain('export * from "./blocks/FormRow"');
    expect(indexContent).toContain('export * from "./blocks/Notice"');
    expect(indexContent).toContain('export * from "./blocks/ComposerControl"');
    expect(indexContent).toContain(
      'export * from "./blocks/ComposerAdjunctPanel"',
    );
    expect(indexContent).toContain(
      'export * from "./blocks/ComposerQueuePanel"',
    );
    expect(indexContent).toContain('export * from "./blocks/CardList"');
    expect(indexContent).toContain('export * from "./blocks/ResourceSummary"');
    expect(indexContent).toContain('export * from "./blocks/SettingsField"');
    expect(indexContent).toContain(
      'export * from "./blocks/TodoProgressPanel"',
    );
    expect(indexContent).toContain(
      'export * from "./blocks/WorkerActivityPanel"',
    );
    expect(indexContent).toContain('export * from "./blocks/ManagementPage"');
    expect(indexContent).toContain('export * from "./blocks/DashboardHeader"');
    expect(indexContent).toContain("designSystemComponents");
    expect(indexContent).toContain("designSystemBlocks");
    expect(indexContent).toContain("Typo");
    expect(buttonContainer).toContain("function gapForButtonSize");
    expect(buttonContainer).toContain('size === "xs" || size === "icon-xs"');
    expect(buttonContainer).toContain('size === "lg" || size === "icon-lg"');
    expect(buttonContainer).toContain('data-slot="button-container"');
  });

  test("design-system skill maps agent component selection and quality gates", () => {
    const skillRoot = join(designSystemRoot, "skills/butler-design-system");
    const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
    const componentMap = readFileSync(
      join(skillRoot, "references/component-map.md"),
      "utf8",
    );
    const skillsReadme = readFileSync(
      join(designSystemRoot, "skills/README.md"),
      "utf8",
    );
    const dsReadme = readFileSync(join(designSystemRoot, "README.md"), "utf8");
    const installer = readFileSync(
      join(designSystemRoot, "scripts/install-design-system-skill.mjs"),
      "utf8",
    );
    const spec = read(
      "project-ledger/projects/butler/specs/butler-dedicated-client-design-system.md",
    );
    const recoveryPlan = read(
      "project-ledger/projects/butler/plans/plan-butler-dedicated-client-design-system-recovery.md",
    );
    const subrepoPlan = read(
      "project-ledger/projects/butler/plans/plan-butler-dedicated-client-design-system-subrepo.md",
    );
    const report = read(
      "project-ledger/projects/butler/reports/butler-dedicated-client-design-system-skill-map.md",
    );

    expect(existsSync(join(skillRoot, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillRoot, "references/component-map.md"))).toBe(
      true,
    );
    expect(installer).toContain('const skillName = "butler-design-system"');
    expect(installer).toContain('join(designSystemRoot, "skills", skillName)');
    expect(skillsReadme).toContain(
      "`butler-design-system` is the canonical skill name",
    );

    expect(skill).toContain("component-selection and quality-gate guide");
    expect(skill).toContain("## Decision Loop");
    expect(skill).toContain("## Container / Presenter Contract");
    expect(skill).toContain("## Styling Rules");
    expect(skill).toContain("## DS Viewer And Render");
    expect(skill).toContain("## Wrong-Turn Guardrails");
    expect(skill).toContain("bun run render Button NavRow CollapsibleNavGroup");
    expect(skill).toContain("320, 375, 390, and 430px");
    expect(skill).toContain("Active navigation states are flat backgrounds");
    expect(skill).toContain("Consecutive buttons must be wrapped in");
    expect(skill).toContain("Do not add component selectors");
    expect(skill).toContain("@/styles/components");
    expect(skill).toContain("project-ledger check");

    expect(componentMap).toContain("## Quick Intent Index");
    expect(componentMap).toContain("## Interaction And Motion");
    expect(componentMap).toContain("## CSS Ownership Map");
    expect(componentMap).toContain("## Agent Quality Gates");
    expect(componentMap).toContain("NavRow` layout has two regions");
    expect(componentMap).toContain(
      "Children in a collapsible navigation group",
    );
    expect(componentMap).toContain("Do not introduce active outlines");
    expect(componentMap).toContain("Use `ButtonContainer` whenever");
    expect(componentMap).toContain(
      "Do not place adjacent `Button` elements in a raw `Stack`",
    );
    expect(componentMap).toContain("Do not build RAG");

    for (const requiredName of [
      "ComposerControl",
      "SettingsField",
      "ActivityFeed",
      "DialogForm",
      "EmptyLine",
      "AutomationRunList",
      "ChromeFrame",
      "TitlebarShell",
      "Clickable",
      "NativeSelect",
      "ButtonContainer",
      "TintedGlass",
    ]) {
      expect(componentMap).toContain(requiredName);
    }

    expect(dsReadme).toContain(
      "bun run render Button NavRow CollapsibleNavGroup",
    );
    expect(spec).toContain(
      "packages/butler-app/client/ui/src/libs/design-system/skills/butler-design-system/SKILL.md",
    );
    expect(recoveryPlan).toContain(
      "packages/butler-app/client/ui/src/libs/design-system/skills/butler-design-system",
    );
    expect(subrepoPlan).toContain(
      "packages/butler-app/client/ui/src/libs/design-system/skills/butler-design-system/SKILL.md",
    );
    expect(report).toContain("REPORT-BDC-DS-SKILL-MAP");
    expect(report).toContain("DS Viewer and `bun run render <Component...>`");

    for (const content of [spec, recoveryPlan, subrepoPlan, report]) {
      expect(content).not.toContain(
        "packages/butler-app/client/ui/src/libs/design-system/skills/design-system",
      );
    }
  });

  test("design-system block files stay presenter-only and renderable", () => {
    const registry = readFileSync(
      join(designSystemRoot, "registry.tsx"),
      "utf8",
    );
    const workbench = readFileSync(
      join(designSystemRoot, "fixtures/DesignSystemWorkbench.tsx"),
      "utf8",
    );
    const indexContent = readFileSync(
      join(designSystemRoot, "index.ts"),
      "utf8",
    );

    for (const name of blockNames) {
      expect(existsSync(blockPath(name, `${name}.tsx`))).toBe(true);
      expect(existsSync(blockPath(name, `${name}.module.css`))).toBe(true);
      expect(existsSync(blockPath(name, `${name}.fixtures.tsx`))).toBe(true);
      expect(existsSync(blockPath(name, "README.md"))).toBe(true);
      expect(existsSync(blockPath(name, "index.ts"))).toBe(true);

      const component = readFileSync(blockPath(name, `${name}.tsx`), "utf8");
      expect(component).not.toMatch(/from ["']@\/(?:app|stores|components)\//u);
      expect(component).not.toContain("window.butlerApp");
      expect(component).not.toContain("appCopy");
      expect(registry).toContain(`name: "${name}"`);
      expect(registry).toContain(`fixture: ${name}Fixture`);
      expect(indexContent).toContain(`export * from "./blocks/${name}"`);
    }

    expect(workbench).toContain("designSystemBlocks");
    expect(workbench).toContain("Blocks");
    expect(workbench).toContain("data-ds-component={component.name}");
    expect(blockNames.length).toBeGreaterThanOrEqual(38);
  });

  test("domain components no longer own CSS module files", () => {
    const componentCssModules = listUiSourceFiles(
      "packages/butler-app/client/ui/src/components",
    ).filter((file) => file.endsWith(".module.css"));
    const componentSources = readUiSources(
      "packages/butler-app/client/ui/src/components",
    );

    expect(componentCssModules).toEqual([]);
    expect(componentSources).not.toContain("@/styles/components");
    expect(componentSources).not.toMatch(/\.module\.css["']/u);
  });

  test("DS Viewer component rendering contracts are covered", () => {
    const tokens = readFileSync(join(designSystemRoot, "tokens.css"), "utf8");
    const separator = readFileSync(
      join(designSystemRoot, "shadcn/ui/separator.tsx"),
      "utf8",
    );
    const viewer = readFileSync(
      join(designSystemRoot, "fixtures/DesignSystemWorkbench.tsx"),
      "utf8",
    );
    const registry = readFileSync(
      join(designSystemRoot, "registry.tsx"),
      "utf8",
    );
    const tabs = readFileSync(
      join(designSystemRoot, "components/Tabs/Tabs.tsx"),
      "utf8",
    );
    const button = readFileSync(
      join(designSystemRoot, "shadcn/ui/button.tsx"),
      "utf8",
    );
    const clickable = readFileSync(
      join(designSystemRoot, "components/Clickable/Clickable.tsx"),
      "utf8",
    );
    const nativeSelect = readFileSync(
      join(designSystemRoot, "shadcn/ui/native-select.tsx"),
      "utf8",
    );
    const pillButton = readFileSync(
      join(designSystemRoot, "components/PillButton/PillButton.tsx"),
      "utf8",
    );
    const buttonStyles = readFileSync(
      join(designSystemRoot, "components/Button/Button.module.css"),
      "utf8",
    );
    const clickableStyles = readFileSync(
      join(designSystemRoot, "components/Clickable/Clickable.module.css"),
      "utf8",
    );
    const nativeSelectStyles = readFileSync(
      join(designSystemRoot, "components/NativeSelect/NativeSelect.module.css"),
      "utf8",
    );
    const inputStyles = readFileSync(
      join(designSystemRoot, "components/Input/Input.module.css"),
      "utf8",
    );
    const textareaStyles = readFileSync(
      join(designSystemRoot, "components/Textarea/Textarea.module.css"),
      "utf8",
    );
    const tintedGlass = readFileSync(
      join(designSystemRoot, "components/TintedGlass/TintedGlass.tsx"),
      "utf8",
    );
    const tintedGlassStyles = readFileSync(
      join(designSystemRoot, "components/TintedGlass/TintedGlass.module.css"),
      "utf8",
    );
    const tintedGlassFixture = readFileSync(
      join(designSystemRoot, "components/TintedGlass/TintedGlass.fixtures.tsx"),
      "utf8",
    );
    const selectStyles = readFileSync(
      join(designSystemRoot, "components/Select/Select.module.css"),
      "utf8",
    );
    const select = readFileSync(
      join(designSystemRoot, "shadcn/ui/select.tsx"),
      "utf8",
    );
    const popover = readFileSync(
      join(designSystemRoot, "shadcn/ui/popover.tsx"),
      "utf8",
    );
    const dropdownMenu = readFileSync(
      join(designSystemRoot, "shadcn/ui/dropdown-menu.tsx"),
      "utf8",
    );
    const contextMenu = readFileSync(
      join(designSystemRoot, "shadcn/ui/context-menu.tsx"),
      "utf8",
    );
    const tooltip = readFileSync(
      join(designSystemRoot, "shadcn/ui/tooltip.tsx"),
      "utf8",
    );
    const floatingConstraints = readFileSync(
      join(designSystemRoot, "lib/floatingConstraints.ts"),
      "utf8",
    );
    const tooltipStyles = readFileSync(
      join(designSystemRoot, "shadcn/ui/tooltip.module.css"),
      "utf8",
    );
    const separatorStyles = readFileSync(
      join(designSystemRoot, "components/Separator/Separator.module.css"),
      "utf8",
    );
    const chartStyles = readFileSync(
      join(designSystemRoot, "components/Chart/Chart.module.css"),
      "utf8",
    );
    const popoverStyles = readFileSync(
      join(designSystemRoot, "components/Popover/Popover.module.css"),
      "utf8",
    );
    const dropdownMenuStyles = readFileSync(
      join(designSystemRoot, "components/DropdownMenu/DropdownMenu.module.css"),
      "utf8",
    );
    const contextMenuStyles = readFileSync(
      join(designSystemRoot, "components/ContextMenu/ContextMenu.module.css"),
      "utf8",
    );
    const dialogStyles = readFileSync(
      join(designSystemRoot, "components/Dialog/Dialog.module.css"),
      "utf8",
    );
    const commandPanelStyles = readFileSync(
      join(designSystemRoot, "blocks/CommandPanel/CommandPanel.module.css"),
      "utf8",
    );
    const conversationShellStyles = readFileSync(
      join(
        designSystemRoot,
        "blocks/ConversationShell/ConversationShell.module.css",
      ),
      "utf8",
    );
    const scrollAreaStyles = readFileSync(
      join(designSystemRoot, "blocks/ScrollArea/ScrollArea.module.css"),
      "utf8",
    );
    const tabsStyles = readFileSync(
      join(designSystemRoot, "components/Tabs/Tabs.module.css"),
      "utf8",
    );
    const navRowStyles = readFileSync(
      join(designSystemRoot, "blocks/NavRow/NavRow.module.css"),
      "utf8",
    );
    const navRow = readFileSync(
      join(designSystemRoot, "blocks/NavRow/NavRow.tsx"),
      "utf8",
    );
    const activityFeed = readFileSync(
      join(designSystemRoot, "blocks/ActivityFeed/ActivityFeed.tsx"),
      "utf8",
    );
    const activityFeedStyles = readFileSync(
      join(designSystemRoot, "blocks/ActivityFeed/ActivityFeed.module.css"),
      "utf8",
    );
    const disclosureRow = readFileSync(
      join(designSystemRoot, "blocks/DisclosureRow/DisclosureRow.tsx"),
      "utf8",
    );
    const disclosureRowStyles = readFileSync(
      join(designSystemRoot, "blocks/DisclosureRow/DisclosureRow.module.css"),
      "utf8",
    );
    const filteredSelectStyles = readFileSync(
      join(
        designSystemRoot,
        "blocks/FilteredSelectPopover/FilteredSelectPopover.module.css",
      ),
      "utf8",
    );
    const markdownContentStyles = readFileSync(
      join(
        designSystemRoot,
        "blocks/MarkdownContent/MarkdownContent.module.css",
      ),
      "utf8",
    );
    const messageRowStyles = readFileSync(
      join(designSystemRoot, "blocks/MessageRow/MessageRow.module.css"),
      "utf8",
    );
    const chromeFrameStyles = readFileSync(
      join(designSystemRoot, "blocks/ChromeFrame/ChromeFrame.module.css"),
      "utf8",
    );
    const workerActivityRow = readFileSync(
      join(designSystemRoot, "blocks/WorkerActivityRow/WorkerActivityRow.tsx"),
      "utf8",
    );
    const workerActivityRowStyles = readFileSync(
      join(
        designSystemRoot,
        "blocks/WorkerActivityRow/WorkerActivityRow.module.css",
      ),
      "utf8",
    );
    const automationRunList = readFileSync(
      join(designSystemRoot, "blocks/AutomationRunList/AutomationRunList.tsx"),
      "utf8",
    );
    const sessionRow = readFileSync(
      join(designSystemRoot, "blocks/SessionRow/SessionRow.tsx"),
      "utf8",
    );
    const titlebarShell = readFileSync(
      join(designSystemRoot, "blocks/TitlebarShell/TitlebarShell.tsx"),
      "utf8",
    );
    const titlebarShellStyles = readFileSync(
      join(designSystemRoot, "blocks/TitlebarShell/TitlebarShell.module.css"),
      "utf8",
    );
    const titlebar = read(
      "packages/butler-app/client/ui/src/components/layout/Titlebar.tsx",
    );
    const collapsible = readFileSync(
      join(
        designSystemRoot,
        "blocks/CollapsibleNavGroup/CollapsibleNavGroup.tsx",
      ),
      "utf8",
    );
    const collapsibleStyles = readFileSync(
      join(
        designSystemRoot,
        "blocks/CollapsibleNavGroup/CollapsibleNavGroup.module.css",
      ),
      "utf8",
    );
    const collapsibleFixture = readFileSync(
      join(
        designSystemRoot,
        "blocks/CollapsibleNavGroup/CollapsibleNavGroup.fixtures.tsx",
      ),
      "utf8",
    );
    const renderScript = read("tests/smoke/ds-viewer-render.ts");
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(viewer).toContain("Butler DS Viewer");
    expect(rootPackage.scripts.render).toContain("ds-viewer-render.ts");
    expect(renderScript).toContain("[data-ds-component]");
    expect(renderScript).toContain("data-ds-view-tab");
    expect(renderScript).toContain(".tmp");
    expect(renderScript).toContain("component.screenshot");
    expect(renderScript).toContain("--viewport");
    expect(renderScript).toContain("iphone");
    expect(renderScript).toContain('"mobile-320"');
    expect(renderScript).toContain('"iphone-375"');
    expect(renderScript).toContain('"iphone-390"');
    expect(renderScript).toContain('"mobile-430"');
    expect(separator).toContain("line = true");
    expect(separator).toContain('tone = "default"');
    expect(separator).toContain('space = "sm"');
    expect(tokens).not.toMatch(/^\[data-slot/m);
    expect(tokens).not.toContain(".liquid-glass-popover");
    expect(buttonStyles).toContain("height: 30px");
    expect(buttonStyles).toContain("flex: 0 0 auto");
    expect(buttonStyles).toContain("width: max-content");
    expect(buttonStyles).toContain("font-weight: var(--font-weight-regular)");
    expect(buttonStyles).not.toContain(
      "font-weight: var(--font-weight-semibold)",
    );
    expect(tokens).toContain("button:not(:disabled)");
    expect(tokens).toContain("a[href]");
    expect(tokens).toContain(
      '[role="button"]:not([aria-disabled="true"], [data-disabled="true"])',
    );
    expect(tokens).toContain("cursor: pointer");
    expect(buttonStyles).toContain('[data-stretch="true"]');
    expect(clickableStyles).toContain('[data-stretch="true"]');
    expect(clickableStyles).toContain("cursor: pointer");
    expect(nativeSelectStyles).toContain('[data-stretch="true"]');
    expect(tokens).not.toContain('[data-slot="clickable"] > *');
    expect(nativeSelectStyles).toContain(".icon");
    expect(tokens).toContain('input:not([type="range"])');
    expect(tokens).toContain("input::placeholder");
    expect(inputStyles).toContain("::placeholder");
    expect(textareaStyles).toContain("::placeholder");
    expect(inputStyles).toContain(":not(:placeholder-shown)");
    expect(tokens).toContain("--tinted-glass-edge-size: 20px;");
    expect(tokens).toContain("--tinted-glass-blur: 4px;");
    expect(tokens).toContain("--tinted-glass-bg: var(--composer-glass-bg);");
    expect(tokens).toContain("--tinted-glass-tint: rgba(255, 255, 255, 1);");
    expect(tokens).toContain("--tinted-glass-tint: rgba(23, 24, 26, 1);");
    expect(tintedGlass).toContain("tintedGlassSurfaceClassName");
    expect(tintedGlass).toContain('data-slot="tinted-glass"');
    expect(tintedGlassStyles).toContain(
      "background-color: var(--tinted-glass-bg)",
    );
    expect(tintedGlassStyles).toContain("background-image:");
    expect(tintedGlassStyles).toContain("100% var(--tinted-glass-edge-size)");
    expect(tintedGlassStyles).toContain(
      "100% max(0px, calc(100% - (var(--tinted-glass-edge-size) * 2)))",
    );
    expect(tintedGlassStyles).toContain(
      "backdrop-filter: var(--tinted-glass-filter)",
    );
    expect(tintedGlassFixture).toContain("backgroundText");
    expect(tintedGlassFixture).toContain("pictureMarks");
    for (const floatingSurface of [
      select,
      popover,
      dropdownMenu,
      contextMenu,
      tooltip,
    ]) {
      expect(floatingSurface).toContain("tintedGlassSurfaceClassName");
    }
    expect(tokens).toContain("--titlebar-safe-area-top");
    expect(floatingConstraints).toContain("TITLEBAR_SAFE_AREA_TOP_PX = 56");
    expect(floatingConstraints).toContain("TITLEBAR_MENU_SIDE_OFFSET_PX = 18");
    expect(titlebar).toContain("TITLEBAR_MENU_SIDE_OFFSET_PX");
    for (const floatingSurface of [
      select,
      popover,
      dropdownMenu,
      contextMenu,
    ]) {
      expect(floatingSurface).toContain("floatingContentCollisionPadding");
      expect(floatingSurface).toContain("collisionPadding");
    }
    expect(tooltip).toContain("clampToTitlebarSafeTop");
    expect(tooltip).toContain("TOOLTIP_FALLBACK_HEIGHT_PX");
    expect(tooltipStyles).toContain("transform: translateX(-50%)");
    expect(tooltipStyles).not.toContain("translate(-50%, -100%)");
    expect(select).toContain('data-radius="popover"');
    expect(popover).toContain('data-radius="popover"');
    expect(dropdownMenu).toContain('data-radius="popover"');
    expect(contextMenu).toContain('data-radius="popover"');
    expect(tooltip).toContain('data-radius="control"');
    for (const floatingSurfaceStyles of [
      selectStyles,
      popoverStyles,
      dropdownMenuStyles,
      contextMenuStyles,
      tooltipStyles,
    ]) {
      expect(floatingSurfaceStyles).not.toContain("--composer-glass-bg");
      expect(floatingSurfaceStyles).not.toContain("--composer-glass-filter");
    }
    expect(selectStyles).toContain("[data-placeholder]");
    expect(separatorStyles).toContain('[data-line="false"]');
    expect(chartStyles).toContain(".chart");
    expect(popoverStyles).toContain("@keyframes popover-open");
    expect(dialogStyles).toContain("@keyframes dialog-open");
    expect(dialogStyles).toContain("scrollbar-width: thin");
    expect(dialogStyles).toContain("var(--titlebar-safe-area-top)");
    expect(dialogStyles).toContain(".content::-webkit-scrollbar-thumb");
    expect(commandPanelStyles).toContain("var(--titlebar-safe-area-top)");
    expect(conversationShellStyles).toContain("scrollbar-width: thin");
    expect(conversationShellStyles).toContain(
      ".scroll::-webkit-scrollbar-thumb",
    );
    expect(tooltip).toContain("TOOLTIP_FALLBACK_WIDTH_PX");
    expect(tooltip).toContain("TOOLTIP_VIEWPORT_PADDING_PX");
    expect(tooltip).toContain("WINDOW_FOCUS_TOOLTIP_SUPPRESSION_MS");
    expect(tooltip).toContain('matches(":focus-visible")');
    expect(tooltip).toContain('window.addEventListener("focus"');
    expect(tooltip).toContain('window.addEventListener("blur"');
    expect(tooltip).toContain("Math.min(Math.max(preferredLeft");
    expect(tooltipStyles).toContain("white-space: nowrap");
    expect(tooltipStyles).toContain("width: max-content");
    expect(scrollAreaStyles).toContain("scrollbar-width: thin");
    expect(scrollAreaStyles).toContain(".scroll::-webkit-scrollbar-thumb");
    expect(registry).toContain('orientation="vertical"');
    expect(registry).toContain('tone="accent"');
    expect(registry).toContain("XAxis");
    expect(registry).toContain("Palette / Grayscale");
    expect(registry).toContain("--grayscale-01");
    expect(registry).toContain("--amber-10");
    expect(registry).toContain("Semantic / Text And Action");
    expect(registry).toContain("--color-text-primary");
    expect(registry).toContain("Controls And Overlays");
    expect(registry).toContain('name: "TintedGlass"');
    expect(registry).toContain("--tinted-glass-filter");
    expect(registry).toContain("--placeholder");
    expect(registry).toContain("Access And Context");
    expect(registry).toContain("--context-chart-free");
    expect(registry).toContain('defaultValue="Butler task"');
    expect(registry).toContain('defaultValue="Actual context value"');
    expect(registry).toContain('<Select defaultValue="one">');
    expect(registry).toContain("designSystemBlocks");
    expect(viewer).toContain("Design Tokens");
    expect(viewer).toContain("ColumnControl");
    expect(viewer).toContain("DetailPage");
    expect(viewer).toContain("MarkdownGuide");
    expect(viewer).toContain("readmeModules");
    expect(viewer).toContain("data-ds-detail");
    expect(viewer).toContain("data-ds-token-name");
    expect(viewer).not.toContain("slice(0, 4)");
    expect(viewer).toContain("fixtureCanvas");
    expect(tabs).toContain("@radix-ui/react-tabs");
    expect(button).toContain("stretch?: boolean");
    expect(button).toContain('data-stretch={stretch ? "true" : undefined}');
    expect(clickable).toContain("stretch?: boolean");
    expect(clickable).toContain('data-stretch={stretch ? "true" : undefined}');
    expect(nativeSelect).toContain("stretch?: boolean");
    expect(nativeSelect).toContain(
      'data-stretch={stretch ? "true" : undefined}',
    );
    expect(pillButton).toContain("stretch?: boolean");
    expect(pillButton).toContain("stretch={stretch}");
    expect(tabs).toContain("Tabs.module.css");
    expect(tabsStyles).toContain("var(--selection)");
    expect(tabsStyles).toContain("transition:");
    expect(tabsStyles).not.toContain("box-shadow");
    expect(navRowStyles).toContain("background-color 120ms ease");
    expect(navRowStyles).toContain("transform 120ms ease");
    expect(navRowStyles).toContain(
      "grid-template-columns: minmax(0, 1fr) auto",
    );
    expect(navRowStyles).toContain(".labelRegion");
    expect(navRowStyles).toContain(".controlRegion");
    expect(navRowStyles).not.toContain("box-shadow");
    expect(navRow).toContain("stretch");
    expect(collapsible).toContain("ariaExpanded={expanded}");
    expect(collapsible).toContain('data-state={expanded ? "open" : "closed"}');
    expect(collapsible).not.toContain("ChevronRight");
    expect(collapsibleStyles).toContain("grid-template-rows");
    expect(collapsibleStyles).toContain("opacity 140ms ease");
    expect(collapsibleStyles).not.toContain("padding-left");
    expect(collapsibleFixture).toContain("useState");
    expect(activityFeed).toContain("className={styles.header}");
    expect(activityFeedStyles).toContain("width: 1lh");
    expect(activityFeedStyles).toContain("text-overflow: ellipsis");
    expect(workerActivityRow).toContain("phaseRail");
    expect(workerActivityRow).toContain("RowActionCluster");
    expect(workerActivityRow).toContain(
      'if (phase === "committing" || phase === "consolidating") return "verifying"',
    );
    expect(workerActivityRow).toContain(
      'const PUBLIC_PHASES = ["orienting", "planning", "executing", "verifying", "reporting"] as const',
    );
    expect(workerActivityRow).toContain(
      "{PUBLIC_PHASES.map((item, index) => (",
    );
    expect(workerActivityRow).toContain(
      'reporting: "Report"',
    );
    expect(workerActivityRow).toContain(
      "data-depth={depth > 0 ? String(depth) : undefined}",
    );
    expect(workerActivityRowStyles).toContain("worker-phase-pulse");
    expect(workerActivityRowStyles).toContain(".noIcon");
    expect(automationRunList).toContain("ActivityFeed");
    expect(disclosureRow).toContain("className={cn(styles.labelRegion");
    expect(disclosureRow).toContain("stretch");
    expect(disclosureRow).toContain("onClick={onToggle}");
    expect(disclosureRow).toContain('surface?: "selection" | "plain"');
    expect(disclosureRow).toContain("data-surface={surface}");
    expect(disclosureRowStyles).toContain(
      "grid-template-columns: minmax(0, 1fr) auto",
    );
    expect(disclosureRowStyles).toContain(".noIcon");
    expect(disclosureRowStyles).toContain(".open:not(.plain)");
    expect(
      read(
        "packages/butler-app/client/ui/src/components/conversation/WorkBlocks.tsx",
      ),
    ).toContain('surface="plain"');
    const workActivityStyles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkActivityBlock/WorkActivityBlock.module.css",
    );
    const workActivity = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkActivityBlock/WorkActivityBlock.tsx",
    );
    const workActivityToolGroup = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkActivityBlock/WorkActivityToolGroup.tsx",
    );
    const workDecisionBody = read(
      "packages/butler-app/client/ui/src/components/conversation/WorkDecisionBody.tsx",
    );
    const workActivityReadme = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkActivityBlock/README.md",
    );
    expect(workActivityStyles).toContain("--work-activity-line-x");
    expect(workActivityStyles).toContain("--work-activity-content-x");
    expect(workActivityStyles).toContain("--work-activity-line-bridge");
    expect(workActivityStyles).toContain(
      "font-weight: var(--font-weight-regular)",
    );
    expect(workActivityStyles).toContain("white-space: normal");
    expect(workActivityStyles).toContain("overflow-wrap: anywhere");
    expect(workActivityStyles).toContain("max-width: min(100%, 760px)");
    expect(workActivityStyles).toContain("border: 1px solid var(--line)");
    expect(workActivityStyles).toContain(".toolGroup");
    expect(workActivityStyles).toContain(".toolDetailButton");
    expect(workActivityStyles).toContain("border: 0");
    expect(workActivityStyles).toContain(".toolDetailText");
    expect(workActivityStyles).toContain(".title");
    expect(workActivityStyles).toContain(".description");
    expect(workActivityStyles).toContain(".toolTitle");
    expect(workActivityStyles).toContain("color: var(--text-secondary)");
    expect(workActivityStyles).toContain("--work-activity-muted-text");
    expect(workActivityStyles).toContain(
      "color: var(--work-activity-muted-text)",
    );
    expect(workActivityStyles).toContain(".toolDetails");
    expect(workActivity).toContain("WorkActivityToolGroup");
    expect(workActivity).not.toContain("tools.map((tool)");
    expect(workActivityToolGroup).toContain("toolGroupSummary");
    expect(workActivityToolGroup).toContain("toolDetailButton");
    expect(workActivityToolGroup).toContain("turn-work-tool-group");
    expect(workActivityToolGroup).toContain("turn-work-tool-detail-row");
    expect(workActivity).toContain('data-slot="work-activity-description"');
    expect(workActivity).toContain('as="div"');
    expect(workActivityToolGroup).toContain(
      'data-slot="work-activity-tool-details"',
    );
    expect(workDecisionBody).toContain('<Typo.Body as="span"');
    expect(workActivityStyles).toContain(".block:not(:last-child)::before");
    expect(workActivityStyles).toContain(
      "bottom: calc(0px - var(--work-activity-line-bridge))",
    );
    expect(workActivityStyles).toContain("width: 100%");
    expect(workActivity).not.toContain("icon = <ListChecks");
    expect(workActivity).toContain('data-slot="work-activity-marker"');
    expect(workActivityStyles).toContain(".marker");
    expect(workActivityStyles).toContain("top: 0.4lh");
    expect(workActivityReadme).toContain("small dot on the line");
    expect(
      read(
        "packages/butler-app/client/ui/src/components/conversation/TurnActivityPanel.tsx",
      ),
    ).toContain('gap="md"');
    expect(
      read(
        "packages/butler-app/client/ui/src/components/conversation/WorkBlocks.tsx",
      ),
    ).toContain('<Stack gap="md">');
    expect(
      read(
        "packages/butler-app/client/ui/src/components/conversation/TurnActivityPanel.tsx",
      ),
    ).toContain("workActivityToolsForBlock(block)");
    expect(
      read(
        "packages/butler-app/client/ui/src/components/conversation/WorkBlocks.tsx",
      ),
    ).toContain("workActivityToolsForBlock(block)");
    expect(
      read(
        "packages/butler-app/client/ui/src/components/inspector/WorkersPanel.tsx",
      ),
    ).toContain("workActivityToolsForBlock(block)");
    expect(messageRowStyles).toContain(
      '+ [data-test-class~="turn-result-section"]',
    );
    expect(messageRowStyles).toContain("margin-top: var(--space-4)");
    expect(filteredSelectStyles).toContain("color: var(--text-primary)");
    expect(filteredSelectStyles).toContain("color: var(--text-secondary)");
    expect(filteredSelectStyles).toContain('[data-selected="true"]');
    expect(filteredSelectStyles).not.toContain("#1f2023");
    expect(filteredSelectStyles).not.toContain("#222326");
    expect(markdownContentStyles).toContain("margin-block: 0");
    expect(markdownContentStyles).toContain(".markdown pre code");
    expect(markdownContentStyles).toContain("background: transparent");
    expect(markdownContentStyles).toContain(".markdown blockquote");
    expect(markdownContentStyles).toContain(".markdown li + li");
    expect(markdownContentStyles).toContain(".markdown table");
    expect(messageRowStyles).toContain(".row > [data-role]");
    expect(chromeFrameStyles).toContain("border-right: 0");
    expect(chromeFrameStyles).toContain(".leftCollapsed .main");
    expect(chromeFrameStyles).toContain(
      "left: var(--chrome-floating-toggle-left)",
    );
    expect(titlebarShell).toContain("className={styles.leading}");
    expect(titlebarShellStyles).toContain("align-items: center");
    expect(titlebarShellStyles).toContain("var(--typo-app-title-line-height)");
    expect(sessionRow).toContain("stretch");
  });

  test("design-system app surface style bridge is retired", () => {
    const indexContent = readFileSync(
      join(designSystemRoot, "index.ts"),
      "utf8",
    );
    const componentSources = readUiSources(
      "packages/butler-app/client/ui/src/components",
    );
    const legacyProductStyles = listUiSourceFiles(
      "packages/butler-app/client/ui/src/styles/components",
    );

    expect(existsSync(join(designSystemRoot, "appComponentStyles.ts"))).toBe(
      false,
    );
    expect(indexContent).not.toContain('from "./appComponentStyles"');
    expect(componentSources).not.toContain("@/styles/components");
    expect(componentSources).not.toMatch(/\b[a-zA-Z]+Styles\b/u);
    expect(legacyProductStyles).toEqual([]);
  });

  test("design-system primitive styles are no longer owned by tokens.css", () => {
    const tokens = readFileSync(join(designSystemRoot, "tokens.css"), "utf8");
    const report = read(
      "project-ledger/projects/butler/reports/butler-dedicated-client-design-system-primitive-stabilization.md",
    );
    const componentSelectors = tokens
      .split("\n")
      .filter((line) =>
        /^(?:\[data-slot|\.liquid-glass-popover|\[data-glass)/u.test(
          line.trim(),
        ),
      );
    const productStyleFiles = listUiSourceFiles(
      "packages/butler-app/client/ui/src/styles/components",
    ).filter((file) => file.endsWith(".module.css"));

    expect(componentSelectors.length).toBe(0);
    expect(componentSelectors).toEqual([]);
    expect(productStyleFiles.length).toBeLessThanOrEqual(24);
    expect(report).toContain(
      "Reduced top-level component selectors in `tokens.css` from the DS-R1 baseline",
    );
    expect(report).toContain("of 115 to 0");
    expect(report).toContain(
      "Primitive implementation styles are owned by primitive CSS modules",
    );
  });

  test("palette and semantic color tokens both exist", () => {
    const cssContent = readFileSync(
      join(appClientPath, "src/libs/design-system/tokens.css"),
      "utf8",
    );
    const appUtils = readFileSync(
      join(appClientPath, "src/app/utils.ts"),
      "utf8",
    );
    const appApi = readFileSync(join(appClientPath, "src/app/api.ts"), "utf8");
    const appShell = readFileSync(
      join(appClientPath, "src/pages/AppShell.tsx"),
      "utf8",
    );
    const nativeAppearanceHook = readFileSync(
      join(appClientPath, "src/hooks/useNativeAppearanceTheme.ts"),
      "utf8",
    );
    const portalThemeHook = readFileSync(
      join(appClientPath, "src/hooks/usePortalThemeClasses.ts"),
      "utf8",
    );
    const electronMain = readFileSync(
      join(root, "packages/butler-app/client/electron/main.mjs"),
      "utf8",
    );
    const electronPreload = readFileSync(
      join(root, "packages/butler-app/client/electron/preload.cjs"),
      "utf8",
    );
    const viewer = readFileSync(
      join(designSystemRoot, "fixtures/DesignSystemWorkbench.tsx"),
      "utf8",
    );

    // Raw palette tokens
    expect(cssContent).toContain("--neutral-white");
    expect(cssContent).toContain("--neutral-light-text-primary");
    expect(cssContent).toContain("--neutral-dark-text-secondary");
    expect(cssContent).toContain("--orange-06");
    expect(cssContent).toContain("--grayscale-01");
    expect(cssContent).toContain("--grayscale-10");
    expect(cssContent).toContain("--blue-02");
    expect(cssContent).toContain("--blue-06");
    expect(cssContent).toContain("--green-06");
    expect(cssContent).toContain("--red-07");
    expect(cssContent).toContain("--amber-06");

    // Semantic tokens
    expect(cssContent).toContain("--color-text-primary");
    expect(cssContent).toContain("--color-text-secondary");
    expect(cssContent).toContain("--color-action-primary");
    expect(cssContent).toContain("--color-disabled-bg");
    expect(cssContent).toContain("--color-border-default");
    expect(cssContent).toContain("--color-surface-base");
    expect(cssContent).toContain("--color-focus-ring");
    expect(cssContent).not.toContain(".theme-system");
    expect(cssContent).not.toContain("@media (prefers-color-scheme: dark)");
    expect(appUtils).toContain("export function resolveAppearanceTheme");
    expect(appUtils).toContain('return prefersDark ? "dark" : "light"');
    expect(appUtils).toContain("theme-${resolveAppearanceTheme");
    expect(appApi).toContain("export async function setNativeAppearanceTheme");
    expect(nativeAppearanceHook).toContain("setNativeAppearanceTheme(theme)");
    expect(appShell).toContain(
      "useNativeAppearanceTheme(settings.appearance_theme)",
    );
    expect(electronPreload).toContain("butler:set-native-appearance-theme");
    expect(electronMain).toContain("nativeTheme.themeSource = themeSource");
    expect(electronMain).toContain(
      'appearanceThemeSources = new Set(["system", "light", "dark"])',
    );
    expect(portalThemeHook).not.toContain("theme-system");
    expect(viewer).not.toContain("theme-system");
    expect(viewer).not.toContain("@/app/");
    expect(viewer).not.toContain("@/hooks/");

    // Check semantic tokens connect to palette/meaning
    expect(cssContent).toContain("--color-text-primary: var(--grayscale-10)");
    expect(cssContent).toContain("--color-action-primary: var(--blue-06)");
    expect(cssContent).toContain("--color-success: var(--green-06)");
    expect(cssContent).toContain("--color-danger: var(--red-07)");
    expect(cssContent).toContain("--ok: var(--color-success)");
    expect(cssContent).toContain("--access-full: var(--orange-06)");
    expect(cssContent).toContain(
      "--color-text-secondary: var(--neutral-dark-text-secondary)",
    );
    expect(cssContent).not.toMatch(
      /^\s*--(?:ok|danger|icon-muted|placeholder|send-bg|send-fg|worker-active|worker-warning|access-full|switch-thumb|color-mix-light)\s*:\s*#[0-9a-fA-F]/m,
    );
    const registry = readFileSync(
      join(appClientPath, "src/libs/design-system/registry.tsx"),
      "utf8",
    );
    const paletteNames = [
      "--grayscale-01",
      "--grayscale-12",
      "--blue-01",
      "--blue-10",
      "--green-01",
      "--green-10",
      "--red-01",
      "--red-10",
      "--amber-01",
      "--amber-10",
      "--neutral-white",
      "--neutral-dark-text-secondary",
      "--orange-06",
      "--green-worker-active",
      "--amber-worker-warning",
    ];
    for (const token of paletteNames) expect(registry).toContain(token);
    expect(registry).toContain("--conversation-bg");
    expect(registry).toContain("--composer-glass-highlight");
    expect(registry).toContain("--dialog-overlay-bg");
    expect(registry).toContain("--context-chart-6");
  });

  test("semantic spacing tokens exist and components use them", () => {
    const cssContent = readFileSync(
      join(appClientPath, "src/libs/design-system/tokens.css"),
      "utf8",
    );
    const stackStyles = readFileSync(
      componentPath("Stack", "Stack.module.css"),
      "utf8",
    );
    const gridStyles = readFileSync(
      componentPath("Grid", "Grid.module.css"),
      "utf8",
    );
    const spaceStyles = readFileSync(
      componentPath("Space", "Space.module.css"),
      "utf8",
    );
    const sectionStyles = readFileSync(
      componentPath("Section", "Section.module.css"),
      "utf8",
    );
    const sectionComponent = readFileSync(
      componentPath("Section", "Section.tsx"),
      "utf8",
    );

    // Semantic spacing tokens in design-system.css
    expect(cssContent).toContain("--space-none: 0");
    expect(cssContent).toContain("--space-xs: 4px");
    expect(cssContent).toContain("--space-sm: 8px");
    expect(cssContent).toContain("--space-md: 12px");
    expect(cssContent).toContain("--space-lg: 16px");
    expect(cssContent).toContain("--space-xl: 20px");
    expect(cssContent).toContain("--space-2xl: 24px");

    // Legacy numeric aliases mapping to semantic tokens
    expect(cssContent).toContain("--space-1: var(--space-xs)");
    expect(cssContent).toContain("--space-2: var(--space-sm)");
    expect(cssContent).toContain("--space-3: var(--space-md)");
    expect(cssContent).toContain("--space-4: var(--space-lg)");
    expect(cssContent).toContain("--space-5: var(--space-xl)");
    expect(cssContent).toContain("--space-6: var(--space-2xl)");

    // Stack component uses semantic spacing tokens
    expect(stackStyles).toContain(".gap-none");
    expect(stackStyles).toContain(".gap-xs");
    expect(stackStyles).toContain(".gap-sm");
    expect(stackStyles).toContain(".gap-md");
    expect(stackStyles).toContain(".gap-lg");
    expect(stackStyles).toContain(".gap-xl");
    expect(stackStyles).toContain(".gap-2xl");
    expect(stackStyles).toContain("gap: var(--space-none)");
    expect(stackStyles).toContain("gap: var(--space-md)");

    // Grid component uses semantic spacing tokens
    expect(gridStyles).toContain(".gap-none");
    expect(gridStyles).toContain(".gap-xs");
    expect(gridStyles).toContain(".gap-sm");
    expect(gridStyles).toContain(".gap-md");
    expect(gridStyles).toContain(".gap-lg");
    expect(gridStyles).toContain(".gap-xl");
    expect(gridStyles).toContain(".gap-2xl");
    expect(gridStyles).toContain("gap: var(--space-md)");

    // Space component uses semantic spacing tokens
    expect(spaceStyles).toContain(".size-none");
    expect(spaceStyles).toContain(".size-xs");
    expect(spaceStyles).toContain(".size-sm");
    expect(spaceStyles).toContain(".size-md");
    expect(spaceStyles).toContain(".size-lg");
    expect(spaceStyles).toContain(".size-xl");
    expect(spaceStyles).toContain(".size-2xl");
    expect(spaceStyles).toContain("--space-size: var(--space-md)");

    // Section delegates spacing to Stack with semantic gap props
    expect(sectionComponent).toContain('gap = "md"');
    expect(sectionComponent).toContain('headerGap = "sm"');
    expect(sectionComponent).toContain('gap="lg"');
    expect(sectionComponent).toContain("<Typo.PanelSectionTitle");
    expect(sectionComponent).not.toContain("titleComponents");
    expect(sectionComponent).toContain("<Stack");
    expect(sectionStyles).toContain(".title-group");
    expect(sectionStyles).toContain("color: var(--color-text-secondary)");
    const settingsHeader = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsHeader/SettingsHeader.tsx",
    );
    const settingsHeaderStyles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsHeader/SettingsHeader.module.css",
    );
    expect(settingsHeader).toContain("className={styles.title}");
    expect(settingsHeaderStyles).toContain("color: var(--color-text-primary)");
  });

  test("typography tokens exist and Typo variants use them", () => {
    const cssContent = readFileSync(
      join(appClientPath, "src/libs/design-system/tokens.css"),
      "utf8",
    );
    const typoStyles = readFileSync(
      componentPath("Typo", "Typo.module.css"),
      "utf8",
    );
    const typoComponent = readFileSync(
      componentPath("Typo", "Typo.tsx"),
      "utf8",
    );

    // Typography tokens in design-system.css
    expect(cssContent).toContain("--typo-h1-size");
    expect(cssContent).toContain("--typo-h1-weight");
    expect(cssContent).toContain("--typo-h2-size");
    expect(cssContent).toContain("--typo-h3-size");
    expect(cssContent).toContain("--typo-h4-size");
    expect(cssContent).toContain("--typo-h5-size");
    expect(cssContent).toContain("--typo-h6-size");
    expect(cssContent).toContain("--typo-body-size");
    expect(cssContent).toContain("--typo-caption-size");
    expect(cssContent).toContain("--typo-label-size");
    expect(cssContent).toContain("--typo-code-size");
    expect(cssContent).toContain("--typo-h1-letter-spacing: 0");
    expect(cssContent).not.toContain("letter-spacing: -0.");

    // Typo component uses tokens
    expect(typoStyles).toContain("font-size: var(--typo-h1-size)");
    expect(typoStyles).toContain("font-weight: var(--typo-h1-weight)");
    expect(typoStyles).toContain("font-size: var(--typo-body-size)");
    expect(typoStyles).toContain("font-size: var(--typo-caption-size)");
    expect(typoStyles).toContain("word-break: keep-all");
    expect(typoStyles).toContain("overflow-wrap: break-word");
    expect(typoStyles).not.toMatch(/^\s*color\s*:/m);
    expect(typoComponent).toContain('| "div"');
  });

  test("Typo color is owned by consuming blocks and app surfaces", () => {
    const cases = [
      [
        "packages/butler-app/client/ui/src/libs/design-system/blocks/ManagementPage/ManagementPage.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/blocks/ManagementPage/ManagementPage.module.css",
        "className={cn(styles.page, className)}",
        "color: var(--text-primary)",
      ],
      [
        "packages/butler-app/client/ui/src/libs/design-system/blocks/DashboardHeader/DashboardHeader.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/blocks/DashboardHeader/DashboardHeader.module.css",
        "className={styles.title}",
        "color: var(--text-primary)",
      ],
      [
        "packages/butler-app/client/ui/src/libs/design-system/blocks/PanelHeader/PanelHeader.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/blocks/PanelHeader/PanelHeader.module.css",
        "className={styles.title}",
        "color: var(--text-primary)",
      ],
      [
        "packages/butler-app/client/ui/src/libs/design-system/blocks/FormSection/FormSection.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/blocks/FormSection/FormSection.module.css",
        "className={styles.title}",
        "color: var(--text-primary)",
      ],
      [
        "packages/butler-app/client/ui/src/libs/design-system/blocks/NavSection/NavSection.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/blocks/NavSection/NavSection.module.css",
        "className={styles.title}",
        "color: var(--text-tertiary)",
      ],
      [
        "packages/butler-app/client/ui/src/libs/design-system/blocks/ActivityFeed/ActivityFeed.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/blocks/ActivityFeed/ActivityFeed.module.css",
        "className={styles.feedTitle}",
        "color: var(--text-primary)",
      ],
      [
        "packages/butler-app/client/ui/src/libs/design-system/blocks/MetricCard/MetricCard.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/blocks/MetricCard/MetricCard.module.css",
        "className={styles.value}",
        "color: var(--text-primary)",
      ],
      [
        "packages/butler-app/client/ui/src/libs/design-system/blocks/DialogForm/DialogForm.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/blocks/DialogForm/DialogForm.module.css",
        "className={styles.title}",
        "color: var(--text-primary)",
      ],
      [
        "packages/butler-app/client/ui/src/libs/design-system/components/Section/Section.tsx",
        "packages/butler-app/client/ui/src/libs/design-system/components/Section/Section.module.css",
        "className={styles.title}",
        "color: var(--color-text-primary)",
      ],
    ] as const;

    for (const [
      componentFile,
      styleFile,
      componentNeedle,
      styleNeedle,
    ] of cases) {
      expect(read(componentFile)).toContain(componentNeedle);
      expect(read(styleFile)).toContain(styleNeedle);
    }

    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/SurfacePanel/SurfacePanel.module.css",
      ),
    ).toContain("color: var(--text-primary)");
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/SettingsField/SettingsField.module.css",
      ),
    ).toContain("color: var(--text-tertiary)");
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/DisclosureRow/DisclosureRow.module.css",
      ),
    ).toContain("color: var(--text-secondary)");
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/TitlebarShell/TitlebarShell.module.css",
      ),
    ).toContain("color: var(--text-primary)");
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/Notice/Notice.module.css",
      ),
    ).toContain("color: var(--blue-07)");
    expect(
      read(
        "packages/butler-app/client/ui/src/components/management/AutomationsList.tsx",
      ),
    ).toContain("<ManagementPage");
    expect(
      read(
        "packages/butler-app/client/ui/src/components/management/AutomationDetail.tsx",
      ),
    ).toContain('as="form"');
    expect(
      read(
        "packages/butler-app/client/ui/src/components/management/AutomationActions.tsx",
      ),
    ).toContain("<BreadcrumbLink asChild>");
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/components/Breadcrumb/Breadcrumb.module.css",
      ),
    ).toContain("appearance: none");
  });

  test("representative files use Typo/Stack/Grid/Section", () => {
    // Titlebar.tsx
    const titlebarContent = readFileSync(
      join(appClientPath, "src/components/layout/Titlebar.tsx"),
      "utf8",
    );
    expect(titlebarContent).toContain("ButtonContainer");
    expect(titlebarContent).toContain("TitlebarShell");
    expect(titlebarContent).toContain("<ButtonContainer");

    // SidebarSection.tsx
    const sidebarContent = readFileSync(
      join(appClientPath, "src/components/layout/SidebarSection.tsx"),
      "utf8",
    );
    const navSectionContent = readFileSync(
      join(
        appClientPath,
        "src/libs/design-system/blocks/NavSection/NavSection.tsx",
      ),
      "utf8",
    );
    expect(sidebarContent).toContain(
      'import { NavSection } from "@/butler-ds"',
    );
    expect(sidebarContent).toContain("<NavSection");
    expect(navSectionContent).toContain('as="section"');
    expect(navSectionContent).toContain("<Typo.SectionTitle");

    // ProjectDashboardHeader.tsx
    const dashboardHeaderContent = readFileSync(
      join(
        appClientPath,
        "src/components/management/ProjectDashboardHeader.tsx",
      ),
      "utf8",
    );
    expect(dashboardHeaderContent).toContain(
      'import { DashboardHeader } from "@/butler-ds"',
    );
    expect(dashboardHeaderContent).toContain("<DashboardHeader");

    // ProjectStatsGrid.tsx
    const statsGridContent = readFileSync(
      join(appClientPath, "src/components/management/ProjectStatsGrid.tsx"),
      "utf8",
    );
    expect(statsGridContent).toContain(
      'import { MetricGrid } from "@/butler-ds"',
    );
    expect(statsGridContent).toContain("<MetricGrid");

    const projectDashboardContent = readFileSync(
      join(appClientPath, "src/components/management/ProjectDashboardView.tsx"),
      "utf8",
    );
    expect(projectDashboardContent).toContain(
      'import { Stack } from "@/butler-ds"',
    );
    expect(projectDashboardContent).toContain('<Stack as="main"');
    expect(projectDashboardContent).not.toContain(
      "<div className={projectDashboardStyles.main}>",
    );

    for (const content of [
      titlebarContent,
      sidebarContent,
      dashboardHeaderContent,
      statsGridContent,
      projectDashboardContent,
    ]) {
      expect(content).not.toMatch(/\bgap="[1-6]"/u);
    }
  });

  test("migrated panels use Section and semantic spacing", () => {
    // Management panels
    const activityPanel = readFileSync(
      join(appClientPath, "src/components/management/ProjectActivityPanel.tsx"),
      "utf8",
    );
    expect(activityPanel).toContain(
      'import { ActivityHeatmap, Section } from "@/butler-ds"',
    );
    expect(activityPanel).toContain("<Section");
    expect(activityPanel).toContain("icon={<Activity");
    expect(activityPanel).not.toContain(
      '<section className="inspector-section">',
    );
    expect(activityPanel).not.toContain("<h3>");

    const documentsPanel = readFileSync(
      join(
        appClientPath,
        "src/components/management/ProjectDocumentsPanel.tsx",
      ),
      "utf8",
    );
    expect(documentsPanel).toContain("NavRow");
    expect(documentsPanel).toContain("ScrollArea");
    expect(documentsPanel).toContain("<Section");
    expect(documentsPanel).toContain("<Grid");
    expect(documentsPanel).toContain("<DocumentTile");
    expect(documentsPanel).toContain("<NavRow");
    expect(documentsPanel).toContain("icon={<BookOpenText");
    expect(documentsPanel).toContain('gap="md"');
    expect(documentsPanel).not.toContain("<button");
    expect(documentsPanel).not.toContain("categoryButton");
    expect(documentsPanel).not.toContain("<h3>");
    const documentDialog = readFileSync(
      join(
        appClientPath,
        "src/components/management/ProjectDocumentDialog.tsx",
      ),
      "utf8",
    );
    expect(documentDialog).toContain("projectDocumentMarkdownView");
    expect(documentDialog).toContain(
      'data-test-class="project-document-frontmatter"',
    );
    expect(documentDialog).toContain("{documentView.body}");
    expect(documentDialog).not.toContain('{document?.markdown ?? ""}');

    const sessionsPanel = readFileSync(
      join(appClientPath, "src/components/management/ProjectSessionsPanel.tsx"),
      "utf8",
    );
    expect(sessionsPanel).toContain(
      'import { Section, SessionRow, Stack } from "@/butler-ds"',
    );
    expect(sessionsPanel).toContain("<Section");
    expect(sessionsPanel).toContain("<Stack");
    expect(sessionsPanel).toContain("<SessionRow");
    expect(sessionsPanel).toContain("icon={<MessageSquarePlus");
    expect(sessionsPanel).toContain('gap="xs"');
    expect(sessionsPanel).not.toContain("<h3>");

    // Inspector panels
    const artifactsPanel = readFileSync(
      join(appClientPath, "src/components/inspector/ArtifactsPanel.tsx"),
      "utf8",
    );
    expect(artifactsPanel).toContain(
      'import { DocumentTile, FileText, Section, Stack } from "@/butler-ds"',
    );
    expect(artifactsPanel).toContain("<Section");
    expect(artifactsPanel).toContain("<Stack");
    expect(artifactsPanel).toContain("<DocumentTile");
    expect(artifactsPanel).toContain("<ArtifactViewer");
    expect(artifactsPanel).toContain("selectedArtifactId");
    expect(artifactsPanel).toContain('clickTarget="tile"');
    expect(artifactsPanel).toContain("artifactDescription(artifact)");
    expect(artifactsPanel).not.toContain("<KeyValueRow");
    expect(artifactsPanel).not.toContain(
      "safe_path_label ?? selectedArtifact.kind",
    );
    expect(artifactsPanel).not.toContain(
      '<section className="inspector-section">',
    );
    expect(artifactsPanel).not.toContain("<h3>Artifacts</h3>");

    const automationPanel = readFileSync(
      join(
        appClientPath,
        "src/components/inspector/AutomationTargetsPanel.tsx",
      ),
      "utf8",
    );
    expect(automationPanel).toContain(
      'import { Clickable, ListRow, Section, Stack } from "@/butler-ds"',
    );
    expect(automationPanel).toContain("<Section");
    expect(automationPanel).toContain('gap="sm"');
    expect(automationPanel).not.toContain("<h3>Automations</h3>");

    const workersPanel = readFileSync(
      join(appClientPath, "src/components/inspector/WorkersPanel.tsx"),
      "utf8",
    );
    expect(workersPanel).toContain("WorkerActivityPanel");
    expect(workersPanel).toContain("groupWorkerActivities");
    expect(workersPanel).toContain("<InspectorPanel");
    expect(workersPanel).toContain("<WorkerActivityPanel");
    expect(workersPanel).toContain("WorkActivityBlock");
    expect(workersPanel).toContain("worker.work_blocks");
    expect(workersPanel).toContain("appCopy.inspector.workers.showDetails");
    expect(workersPanel).toContain('density="compact"');
    expect(workersPanel).toContain("details: detailBlocks");
    expect(workersPanel).toContain("toggleWorker");
    expect(workersPanel).toContain("<Stack");
    expect(workersPanel).not.toContain(
      '<section className="inspector-section">',
    );
    expect(workersPanel).not.toContain("<h3>Workers</h3>");
  });

  test("worker details and work blocks stay compact inside inspector width", () => {
    const workBlock = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkActivityBlock/WorkActivityBlock.tsx",
    );
    const workBlockStyles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkActivityBlock/WorkActivityBlock.module.css",
    );
    const workerRow = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/WorkerActivityRow/WorkerActivityRow.tsx",
    );
    const inspectorShellStyles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/InspectorShell/InspectorShell.module.css",
    );
    const inspectorLayout = read(
      "packages/butler-app/client/ui/src/components/inspector/inspectorLayout.ts",
    );
    const summaryPanel = read(
      "packages/butler-app/client/ui/src/components/inspector/SummaryPanel.tsx",
    );
    const surfacePanelStyles = read(
      "packages/butler-app/client/ui/src/libs/design-system/blocks/SurfacePanel/SurfacePanel.module.css",
    );
    const stackStyles = read(
      "packages/butler-app/client/ui/src/libs/design-system/components/Stack/Stack.module.css",
    );

    expect(workBlock).toContain('density?: "normal" | "compact"');
    expect(workBlock).toContain('gap={density === "compact" ? "1" : "sm"}');
    expect(workBlock).toContain("<Typo.Body");
    expect(workBlock).not.toContain("<Typo.PanelSectionTitle");
    expect(workBlockStyles).toContain(".compact");
    expect(workBlockStyles).toContain("font-size: var(--typo-caption-size)");
    expect(workBlockStyles).toContain(
      "line-height: var(--typo-caption-line-height)",
    );
    expect(workBlockStyles).toContain("max-width: 100%");
    expect(workerRow).toContain("details?: ReactNode");
    expect(workerRow).toContain("styles.details");
    expect(inspectorShellStyles).toContain("min-width: 0");
    expect(inspectorShellStyles).toContain("width: 100%");
    expect(inspectorShellStyles).toContain("contain: layout paint style");
    expect(inspectorShellStyles).toContain(
      "padding: 0 var(--inspector-inline-padding)",
    );
    expect(inspectorLayout).toContain("width: `calc(100% -");
    expect(summaryPanel).toContain('data-test-class="summary-progress-panel"');
    expect(surfacePanelStyles).toContain("box-sizing: border-box");
    expect(surfacePanelStyles).toContain("min-width: 0");
    expect(inspectorShellStyles).not.toContain("width: calc(100% + 36px)");
    expect(inspectorShellStyles).not.toContain("margin: 0 -18px");
    expect(stackStyles).toContain("min-width: 0");
  });

  test("app UI chrome uses compact typography variants not document headings", () => {
    const cssContent = readFileSync(
      join(appClientPath, "src/libs/design-system/tokens.css"),
      "utf8",
    );
    const typoComponent = readFileSync(
      componentPath("Typo", "Typo.tsx"),
      "utf8",
    );
    const typoStyles = readFileSync(
      componentPath("Typo", "Typo.module.css"),
      "utf8",
    );

    // App UI typography tokens exist
    expect(cssContent).toContain("--typo-app-title-size: 15px");
    expect(cssContent).toContain("--typo-app-title-weight: 620");
    expect(cssContent).toContain("--typo-panel-title-size: 15px");
    expect(cssContent).toContain("--typo-section-title-size: 13px");
    expect(cssContent).toContain("--typo-panel-section-title-size: 15px");
    expect(cssContent).toContain("--typo-dashboard-title-size: 24px");
    expect(cssContent).toContain("--typo-dashboard-title-weight: 620");
    expect(cssContent).toContain("--typo-metric-value-size: 18px");

    // App UI variants are exported
    expect(typoComponent).toContain("export const AppTitle");
    expect(typoComponent).toContain("export const PanelTitle");
    expect(typoComponent).toContain("export const DashboardTitle");
    expect(typoComponent).toContain("export const SectionTitle");
    expect(typoComponent).toContain("export const PanelSectionTitle");
    expect(typoComponent).toContain("export const MetricValue");
    expect(typoComponent).toContain('createTypo("span", styles["app-title"])');
    expect(typoComponent).toContain(
      'createTypo("span", styles["panel-title"])',
    );
    expect(typoComponent).toContain(
      'createTypo("span", styles["section-title"])',
    );
    expect(typoComponent).toContain("AppTitle,");
    expect(typoComponent).toContain("PanelTitle,");
    expect(typoComponent).toContain("DashboardTitle,");
    expect(typoComponent).toContain("SectionTitle,");
    expect(typoComponent).toContain("PanelSectionTitle,");
    expect(typoComponent).toContain("MetricValue,");

    // App UI variants have styles
    expect(typoStyles).toContain(".app-title");
    expect(typoStyles).toContain(".panel-title");
    expect(typoStyles).toContain(".dashboard-title");
    expect(typoStyles).toContain(".section-title");
    expect(typoStyles).toContain(".panel-section-title");
    expect(typoStyles).toContain(".metric-value");
    expect(typoStyles).toContain("font-size: var(--typo-app-title-size)");
    expect(typoStyles).toContain("font-size: var(--typo-section-title-size)");

    // Titlebar must NOT use document headings for app chrome
    const titlebarContent = readFileSync(
      join(
        appClientPath,
        "src/libs/design-system/blocks/TitlebarShell/TitlebarShell.tsx",
      ),
      "utf8",
    );
    expect(titlebarContent).not.toContain("<Typo.H1");
    expect(titlebarContent).not.toContain("<Typo.H2");
    expect(titlebarContent).not.toContain("<Typo.H3");
    expect(titlebarContent).toContain("<Typo.AppTitle");
    expect(titlebarContent).not.toContain(
      '<Stack gap="xs" className={styles.copy}>',
    );
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/TitlebarShell/TitlebarShell.module.css",
      ),
    ).toContain("display: inline-flex");

    // SidebarSection must NOT use document headings for chrome
    const sidebarContent = readFileSync(
      join(appClientPath, "src/components/layout/SidebarSection.tsx"),
      "utf8",
    );
    expect(sidebarContent).not.toContain("<Typo.H1");
    expect(sidebarContent).not.toContain("<Typo.H2");
    expect(sidebarContent).not.toContain("<Typo.H3");
    expect(sidebarContent).toContain("<NavSection");

    // ProjectDashboardHeader must NOT use document headings for app titles
    const dashboardHeaderContent = readFileSync(
      join(
        appClientPath,
        "src/components/management/ProjectDashboardHeader.tsx",
      ),
      "utf8",
    );
    expect(dashboardHeaderContent).not.toContain("<Typo.H1");
    expect(dashboardHeaderContent).not.toContain("<Typo.H2");
    expect(dashboardHeaderContent).toContain("<DashboardHeader");

    // DashboardStat must NOT use document headings for metrics
    const dashboardStatContent = readFileSync(
      join(appClientPath, "src/components/management/DashboardStat.tsx"),
      "utf8",
    );
    expect(dashboardStatContent).not.toContain("<Typo.H3");
    expect(dashboardStatContent).not.toContain("<Typo.H4");
    expect(dashboardStatContent).not.toContain("<Typo.H5");
    expect(dashboardStatContent).toContain("<MetricCard");

    // Settings detail header uses appropriate Typo variants
    const settingsHeaderContent = readFileSync(
      join(appClientPath, "src/components/settings/SettingsDetailHeader.tsx"),
      "utf8",
    );
    const settingsSectionContent = readFileSync(
      join(appClientPath, "src/components/settings/SettingsSection.tsx"),
      "utf8",
    );
    expect(settingsHeaderContent).toContain(
      'import { Notice, SettingsHeader } from "@/butler-ds"',
    );
    expect(settingsHeaderContent).toContain("<SettingsHeader");
    expect(settingsSectionContent).toContain("<FormSection");
    expect(settingsHeaderContent).not.toContain("<Typo.H4");
    expect(settingsSectionContent).not.toContain("<h3>{title}</h3>");
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/SidebarShell/SidebarShell.tsx",
      ),
    ).toContain('cn(styles.titlebar, "drag-region")');
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/SidebarShell/SidebarShell.module.css",
      ),
    ).toContain("user-select: none");
    expect(
      read(
        "packages/butler-app/client/ui/src/libs/design-system/blocks/FormSection/FormSection.module.css",
      ),
    ).toContain("gap: var(--space-xl)");
  });
});

test("message virtualization isolates virtual row updates from message content", () => {
  const messageList = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageList.tsx",
  );
  const messageItem = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageItem.tsx",
  );
  const messageContent = read(
    "packages/butler-app/client/ui/src/components/conversation/MessageContent.tsx",
  );
  const workBlocks = read(
    "packages/butler-app/client/ui/src/components/conversation/CompletedWorkBlocks.tsx",
  );
  const virtualizer = read(
    "packages/butler-app/client/ui/src/components/conversation/hooks/useMessageVirtualizer.ts",
  );
  const autoScroll = read(
    "packages/butler-app/client/ui/src/components/conversation/hooks/useConversationAutoScroll.ts",
  );
  const footer = read(
    "packages/butler-app/client/ui/src/components/conversation/AssistantResponseFooter.tsx",
  );
  const shellCss = read(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ConversationShell/ConversationShell.module.css",
  );

  expect(messageList).not.toContain("ResizeObserver");
  expect(messageList).not.toContain("useAnimationFrameWithResizeObserver");
  expect(messageList).not.toContain("contentVersion");
  expect(messageList).toContain("useMessageVirtualizer");
  expect(virtualizer).toContain("rowVirtualizer.scrollRect?.height");
  expect(virtualizer).toContain(
    "shouldAdjustScrollPositionOnItemSizeChange",
  );
  expect(virtualizer).toContain("keepScrollOffsetOnSizeChange");
  expect(virtualizer).not.toContain("scrollToFn:");
  expect(autoScroll).toContain("latestMessageVersion");
  expect(autoScroll).toContain("virtualListHeight");
  expect(autoScroll).not.toContain("lastKnownUnpinnedScrollTopRef");
  expect(autoScroll).not.toContain("USER_SCROLL_INPUT_WINDOW_MS");
  expect(autoScroll).not.toContain("element.scrollTop = expectedScrollTop");
  expect(messageItem).toContain("<VirtualMessageRow");
  expect(messageItem).toContain("<MessageContent");
  expect(messageContent).not.toContain("virtualRow");
  expect(messageContent).not.toContain("rowVirtualizer");
  expect(messageContent).not.toContain("topOffset");
  expect(messageContent).not.toContain("useButlerStore");
  expect(workBlocks).not.toContain("useButlerStore");
  expect(workBlocks).not.toContain("turnProgress");
  expect(messageContent).toContain("message.work_blocks");
  expect(messageContent.indexOf("<CompletedWorkBlocks")).toBeLessThan(
    messageContent.indexOf("<MessageMarkdown"),
  );
  expect(messageContent.indexOf("<CompletedWorkBlocks")).toBeLessThan(
    messageContent.indexOf("<AssistantFailureNotice"),
  );
  expect(footer).not.toContain("messages:");
  expect(footer).not.toContain("messageIndex");
  expect(shellCss).toContain("overflow-anchor: none");
  expect(shellCss).not.toContain(".virtualScroll *");
  expect(shellCss).toContain(".virtualizedMessageList {\n  position: relative;");
  expect(shellCss).not.toContain(
    "align-content: stretch;\n  overflow-anchor: none;",
  );
  expect(shellCss).not.toContain("width: 100%;\n  overflow-anchor: none;");
});

test("component line count lint script is wired into lint:design", () => {
  const rootPackage = JSON.parse(read("package.json"));
  const lintScript = read(
    "packages/butler-app/scripts/lint/component-line-count-lint.ts",
  );

  // Verify script exists and is part of lint:design
  expect(
    existsSync(
      join(
        root,
        "packages/butler-app/scripts/lint/component-line-count-lint.ts",
      ),
    ),
  ).toBe(true);
  expect(rootPackage.scripts["lint:design"]).toContain(
    "component-line-count-lint.ts",
  );

  // Verify script covers app/domain components and design-system components.
  expect(lintScript).toContain("const componentRoots");
  expect(lintScript).toContain("designSystemComponentsPath");
  expect(lintScript).toContain("designSystemBlocksPath");
  expect(lintScript).toContain('entry === "hooks"');
  expect(lintScript).toContain("function isHookFile");
  expect(lintScript).toContain("!isHookFile(entry)");

  // Verify it enforces 160 line threshold
  expect(lintScript).toContain("const LINE_LIMIT = 160");
  expect(lintScript).toContain("function countLines");
  expect(lintScript).toContain("lineCount > LINE_LIMIT");

  // Verify it fails on violations
  expect(lintScript).toContain("console.error");
  expect(lintScript).toContain("process.exit(1)");

  // Verify it scans TypeScript/TSX files only
  expect(lintScript).toContain('entry.endsWith(".ts")');
  expect(lintScript).toContain('entry.endsWith(".tsx")');

  // Verify it skips test and spec files
  expect(lintScript).toContain('entry.includes(".test.")');
  expect(lintScript).toContain('entry.includes(".spec.")');

  // Verify readable output format
  expect(lintScript).toContain("Component line count lint failed:");
  expect(lintScript).toContain("lines (exceeds");
  expect(lintScript).toContain("line limit)");
  expect(lintScript).toContain("Refactor these components");

  const result = spawnSync(
    "bun",
    [
      "run",
      "packages/butler-app/scripts/lint/component-line-count-lint.ts",
      "--verbose",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status).toBe(0);
  expect(output).toContain("Component line count lint passed");
  expect(output).not.toContain("Component line count warnings:");
  expect(output).not.toContain("exceeds 160 line limit");
  expect(output).not.toContain(
    "packages/butler-app/client/ui/src/libs/design-system/shadcn/ui/",
  );
});
