import type { Page } from "playwright";

const sidebar = '[data-test-class~="app-sidebar"]';
const card = '[data-slot="adaptive-shell-workspace"] :is([data-slot="adaptive-shell-card"], [data-slot="adaptive-shell-split-chat"])';

/**
 * The sidebar's first row fill (selected, then hovered) starts on the same
 * line as the content card's top edge, in light and dark. Call it while the
 * first row is the selected one (a new chat is open).
 */
export async function assertSidebarFirstRowBaseline(page: Page, shell: string): Promise<void> {
  const row = page.locator(`${sidebar} nav`).first().getByRole("button").first();
  const original = await page.locator(shell).getAttribute("class");
  const read = () => page.evaluate(({ sidebar, card }) => {
    const nav = document.querySelector(`${sidebar} nav`);
    const first = nav?.querySelector<HTMLElement>('button,[role="button"]');
    const fill = first && getComputedStyle(first).backgroundColor;
    const content = [...document.querySelectorAll<HTMLElement>(card)].find((node) => node.getBoundingClientRect().height > 0);
    return { fill, rowTop: first?.getBoundingClientRect().top, cardTop: content?.getBoundingClientRect().top };
  }, { sidebar, card });
  const check = async (state: string, theme: string) => {
    const facts = await read();
    if (facts.rowTop === undefined || facts.cardTop === undefined || !facts.fill || facts.fill === "rgba(0, 0, 0, 0)" ||
      Math.abs(facts.rowTop - facts.cardTop) > 0.5) {
      throw new Error(`sidebar first row (${state}, ${theme}) should start level with the content card: ${JSON.stringify(facts)}`);
    }
  };
  try {
    for (const theme of ["light", "dark"]) {
      await page.locator(shell).evaluate((root, theme) => {
        root.classList.remove("theme-system", "theme-light", "theme-dark");
        root.classList.add(`theme-${theme}`);
      }, theme);
      await page.mouse.move(900, 450);
      await check("selected", theme);
      await row.hover();
      await check("hover", theme);
    }
  } finally {
    await page.locator(shell).evaluate((root, value) => root.setAttribute("class", value ?? ""), original);
    await page.mouse.move(900, 450);
  }
}
