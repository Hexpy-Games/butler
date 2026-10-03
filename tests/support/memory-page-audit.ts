import type { Page } from "playwright";
/** Computed-layout evidence from the shipped page, including its shared dialog. */
export async function auditMemoryDesign(page: Page) {
  return page.evaluate(() => {
    const visible = (node: HTMLElement) => node.getBoundingClientRect().width > 0;
    const cards = [...document.querySelectorAll<HTMLElement>('[data-slot="form-section-card"]')].filter(visible);
    const fields = [...document.querySelectorAll<HTMLElement>('[data-settings-field]')].filter(visible);
    const icons = [...document.querySelectorAll<HTMLElement>('[data-slot="icon-slot"]')].filter(visible);
    const padding = cards.map(node => {
      const css = getComputedStyle(node);
      return { kind: node.dataset.kind, values: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft] };
    });
    const labelsAboveControls = fields.map(node => {
      const label = node.querySelector('label');
      const control = node.querySelector('button, input, select, textarea');
      return !label || !control || label.getBoundingClientRect().bottom <= control.getBoundingClientRect().top + 1;
    });
    const iconFirstLine = icons.map(node => {
      const css = getComputedStyle(node.parentElement!);
      return { align: css.alignItems, height: node.getBoundingClientRect().height, minHeight: node.dataset.minHeight };
    });
    const scrollers = [...document.querySelectorAll<HTMLElement>('[class*="ScrollArea"][class*="viewport"], [data-test-class="settings-detail-scroll"]')].filter(visible).map(node => ({
      scrollable: node.scrollHeight > node.clientHeight + 1,
      mask: getComputedStyle(node).maskImage,
      horizontal: node.scrollWidth > node.clientWidth + 1,
    }));
    const notices = [...document.querySelectorAll<HTMLElement>('[class*="_notice_"]')].filter(visible).map(node => {
      const content = node.firstElementChild;
      return { outer: getComputedStyle(node).alignItems, content: content ? getComputedStyle(content).alignItems : "none" };
    });
    const color = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const blend = (front: number[], back: number[]) => {
      const alpha = front[3] ?? 1;
      return [0, 1, 2].map(i => front[i]! * alpha + back[i]! * (1 - alpha));
    };
    const background = (node: HTMLElement): number[] => {
      const chain: HTMLElement[] = [];
      for (let current: HTMLElement | null = node; current; current = current.parentElement) chain.unshift(current);
      let value = [255, 255, 255];
      for (const ancestor of chain) value = blend(color(getComputedStyle(ancestor).backgroundColor), value);
      return value;
    };
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, .7152, .0722][i]!, 0);
    const contrast = cards.flatMap(card => [...card.querySelectorAll<HTMLElement>('label, [id^="instruction-text"], [data-tone="secondary"], [data-tone="tertiary"]')].filter(visible).map(node => {
      const bg = background(node);
      const fg = blend(color(getComputedStyle(node).color), bg);
      const a = luminance(fg), b = luminance(bg);
      return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05),
        id: node.id, tag: node.tagName, tone: node.dataset.tone,
        foreground: getComputedStyle(node).color, background: bg,
        disabled: Boolean(node.closest('[disabled], [aria-disabled="true"]')) };
    }));
    return { padding, labelsAboveControls, iconFirstLine, scrollers, notices,
      cardContrast: cards.map(card => ({ card: background(card), surround: background(card.parentElement!) })),
      minimumTextContrast: contrast.length ? Math.min(...contrast.map(row => row.ratio)) : null,
      contrastFailures: contrast.filter(row => row.ratio < 4.5) };
  });
}
