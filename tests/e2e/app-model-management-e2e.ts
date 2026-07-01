import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import {
  FIRST_RUN_STORAGE_KEY,
  firstRunCompleteState,
} from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";

const root = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "butler-model-management-e2e-"));
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const testClass = (name: string) => `[data-test-class~="${name}"]`;

const hostedProviders = [
  { label: "OpenAI", model: "GPT-5.5" },
  { label: "Anthropic", model: "Claude Opus 4.7" },
  { label: "Google", model: "Gemini 3.1 Pro Preview" },
  { label: "xAI / Grok", model: "Grok 4.3" },
  { label: "Qwen Cloud", model: "Qwen3.7 Max" },
  { label: "Moonshot / Kimi", model: "Kimi K2.6" },
  { label: "Z.AI / GLM", model: "GLM-5.2" },
  { label: "OpenCode Go", model: "GLM-5.2" },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function clickButton(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
}

async function clickSidebarAction(page: Page, label: string): Promise<void> {
  const action = page
    .locator(
      `[data-test-class="app-sidebar"] [role="button"][aria-label="${label}"]`,
    )
    .first();
  if (!(await action.isVisible().catch(() => false))) {
    const showSidebar = page.getByRole("button", {
      name: "Show sidebar",
      exact: true,
    });
    if (await showSidebar.isVisible().catch(() => false)) {
      await showSidebar.click();
    }
  }
  await action.waitFor({ state: "visible" });
  await action.click();
}

async function openSelect(page: Page, selector: string): Promise<void> {
  const trigger = page.locator(selector).first();
  await trigger.waitFor({ state: "visible" });
  await trigger.click();
}

async function selectOption(
  page: Page,
  triggerSelector: string,
  label: string,
): Promise<void> {
  await openSelect(page, triggerSelector);
  await page.getByRole("option", { name: label, exact: true }).click();
}

async function assertSelectHasOptions(
  page: Page,
  triggerSelector: string,
  labels: readonly string[],
): Promise<void> {
  await openSelect(page, triggerSelector);
  for (const label of labels) {
    await page.getByRole("option", { name: label, exact: true }).waitFor({
      state: "visible",
    });
  }
  await page.getByRole("option", { name: labels[0], exact: true }).click();
}

async function assertSelectHasModel(page: Page, label: string): Promise<void> {
  await openSelect(page, testClass("hosted-model-select"));
  const option = page.getByRole("option", {
    name: new RegExp(`^${escapeRegExp(label)}\\b`, "u"),
  });
  await option.waitFor({ state: "visible" });
  await option.click();
}

async function seedCompletedFirstRun(page: Page): Promise<void> {
  const firstRunState = JSON.stringify(firstRunCompleteState("en"));
  await page.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: FIRST_RUN_STORAGE_KEY, value: firstRunState },
  );
}

async function startLocalModelServer(): Promise<{
  url: string;
  server: Server;
}> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-e2e-model.gguf" }] }));
      return;
    }
    if (request.url?.startsWith("/props")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
  const address = server.address();
  assert(
    address && typeof address === "object",
    "local model server address missing",
  );
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
  };
}

assert(
  existsSync(join(uiRoot, "index.html")),
  "UI dist is missing; run app UI build first.",
);

const server = createAppServer({
  dbPath: join(tempDir, "model-management-e2e.sqlite"),
  butlerData: tempDir,
  uiRoot,
  port: 0,
  bridgeMode: "external",
  automationSchedulerIntervalMs: false,
});
const localModelServer = await startLocalModelServer();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
await seedCompletedFirstRun(page);

try {
  const catalogResponse = await fetch(`${server.url}model-catalog`);
  const catalogEnvelope = await catalogResponse.json();
  const catalog = catalogEnvelope.data;
  for (const provider of hostedProviders) {
    const match = catalog.providers.find(
      (item: { provider_label: string }) =>
        item.provider_label === provider.label,
    );
    assert(match, `provider is missing from catalog: ${provider.label}`);
    assert(
      match.models.length > 0,
      `provider has no models: ${provider.label}`,
    );
  }

  await page.goto(server.url, { waitUntil: "networkidle" });
  await clickSidebarAction(page, appCopy.sidebar.settings);
  await clickButton(page, appCopy.settings.sections.models);
  await page
    .getByText(appCopy.settings.panels.butlerModel, { exact: true })
    .waitFor({ state: "visible" });
  const rootTitle = await page
    .locator(testClass("settings-detail-title"))
    .innerText();
  assert(
    rootTitle.trim() === appCopy.settings.sections.models,
    "models root title should remain the section title",
  );
  const routeNav = page.locator(testClass("settings-model-route-nav"));
  const rootRouteNavBox = await routeNav.boundingBox();
  const rootRouteNavVisibility = await routeNav.evaluate(
    (element) => getComputedStyle(element).visibility,
  );
  assert(
    rootRouteNavBox && rootRouteNavBox.height > 0,
    "hidden model route row should reserve height",
  );
  assert(
    rootRouteNavVisibility === "hidden",
    "models root route row should be hidden",
  );
  const primaryModelBox = await page
    .locator(testClass("settings-primary-model-select"))
    .boundingBox();
  const primaryReasoningBox = await page
    .locator(testClass("settings-primary-reasoning-select"))
    .boundingBox();
  const managementButtonBox = await page
    .locator(testClass("settings-model-management-button"))
    .boundingBox();
  assert(
    primaryModelBox && primaryReasoningBox && managementButtonBox,
    "model controls should render",
  );
  assert(
    Math.abs(primaryModelBox.width - primaryReasoningBox.width) <= 1,
    "primary model selector should match the surrounding control width",
  );
  assert(
    Math.abs(primaryModelBox.height - managementButtonBox.height) <= 1,
    "model management button should match the model selector height",
  );
  await clickButton(page, appCopy.settings.modelManagement.manageButton);
  const managementTitle = await page
    .locator(testClass("settings-detail-title"))
    .innerText();
  assert(
    managementTitle.trim() === appCopy.settings.sections.models,
    "model management title should remain the section title",
  );
  const managementRouteNavText = await routeNav.innerText();
  const managementRouteNavVisibility = await routeNav.evaluate(
    (element) => getComputedStyle(element).visibility,
  );
  assert(
    managementRouteNavVisibility === "visible",
    "model management route row should be visible",
  );
  assert(
    managementRouteNavText.includes(appCopy.settings.sections.models) &&
      managementRouteNavText.includes(appCopy.settings.modelManagement.title),
    "model management breadcrumb row is missing",
  );
  await clickButton(page, appCopy.settings.modelManagement.addButton);
  const addTitle = await page
    .locator(testClass("settings-detail-title"))
    .innerText();
  assert(
    addTitle.trim() === appCopy.settings.sections.models,
    "model add title should remain the section title",
  );
  const addRouteNavText = await routeNav.innerText();
  assert(
    addRouteNavText.includes(appCopy.settings.modelManagement.title) &&
      addRouteNavText.includes(appCopy.settings.modelManagement.addTitle),
    "model add breadcrumb row is missing",
  );

  await assertSelectHasOptions(page, testClass("model-add-provider-select"), [
    ...hostedProviders.map((provider) => provider.label),
    appCopy.settings.options.local,
  ]);

  for (const provider of hostedProviders) {
    await selectOption(
      page,
      testClass("model-add-provider-select"),
      provider.label,
    );
    await page.locator(testClass("hosted-model-select")).waitFor({
      state: "visible",
    });
    await assertSelectHasModel(page, provider.model);
    const selectedModelText = await page
      .locator(testClass("hosted-model-select"))
      .innerText();
    assert(
      selectedModelText.trim().length > 0,
      `model select should not be empty for ${provider.label}`,
    );
  }

  await selectOption(
    page,
    testClass("model-add-provider-select"),
    hostedProviders[0].label,
  );
  await selectOption(
    page,
    testClass("hosted-auth-method-select"),
    appCopy.settings.modelManagement.codexOauth,
  );
  await clickButton(page, appCopy.settings.modelManagement.saveAdd);
  await page
    .getByText(appCopy.settings.modelManagement.codexOauth, { exact: true })
    .first()
    .waitFor({ state: "visible" });
  assert(
    (await page.getByText("Codex 브라우저 로그인").count()) === 0,
    "registered model auth badge should use OAuth label",
  );
  await clickButton(page, appCopy.settings.modelManagement.addButton);

  await selectOption(
    page,
    testClass("model-add-provider-select"),
    appCopy.settings.options.local,
  );
  await page.getByText(appCopy.settings.localModels.apiInfoTitle).waitFor({
    state: "visible",
  });
  await page
    .getByLabel(appCopy.settings.localModels.serverUrl)
    .fill(localModelServer.url);
  await clickButton(page, appCopy.settings.localModels.discoverModels);
  await page
    .getByText(appCopy.settings.localModels.discoveredStatus(1))
    .waitFor({ state: "visible" });
  await page.getByText(appCopy.settings.localModels.modelInfoTitle).waitFor({
    state: "visible",
  });
  await page.getByLabel(appCopy.settings.localModels.modelId).waitFor({
    state: "visible",
  });

  console.log("Model management E2E passed");
} finally {
  await browser.close();
  localModelServer.server.close();
  server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
