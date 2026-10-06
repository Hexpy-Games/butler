import type { Page } from "playwright";

type Fiber = { type: unknown; flags: number; memoizedProps: Record<string, unknown> | null;
  memoizedState: unknown; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null };
type Probe = { commits: number[]; decorationRenders: number; drawMs: number[]; draws: number };
type ProbeWindow = Window & { __decorationProbe: Probe; __resetDecorationProbe(): void };

/** Actual input-to-React-commit latency and GL submission work; no pixels read. */
export async function installDecorationProbe(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as ProbeWindow;
    const seen = new WeakMap<Fiber, { props: unknown; state: unknown }>();
    target.__resetDecorationProbe = () => {
      target.__decorationProbe = { commits: [], decorationRenders: 0, drawMs: [], draws: 0 };
    };
    target.__resetDecorationProbe();
    let inputAt: number | undefined;
    document.addEventListener("beforeinput", (event) => {
      if ((event.target as HTMLElement)?.isContentEditable) inputAt = performance.now();
    }, true);
    const visit = (fiber: Fiber | null) => {
      if (!fiber) return;
      const prior = seen.get(fiber) ?? (fiber.alternate ? seen.get(fiber.alternate) : undefined);
      const changed = !prior || prior.props !== fiber.memoizedProps || prior.state !== fiber.memoizedState;
      if (changed && (fiber.flags & 1) && typeof fiber.type === "function" && ["shoreline", "cherry"].includes(String(fiber.memoizedProps?.scene))) {
        target.__decorationProbe.decorationRenders++;
      }
      const snapshot = { props: fiber.memoizedProps, state: fiber.memoizedState };
      seen.set(fiber, snapshot);
      if (fiber.alternate) seen.set(fiber.alternate, snapshot);
      visit(fiber.child); visit(fiber.sibling);
    };
    Object.assign(window, { __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true, inject: () => 1, onCommitFiberUnmount: () => undefined,
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        if (inputAt !== undefined) {
          target.__decorationProbe.commits.push(performance.now() - inputAt);
          inputAt = undefined;
        }
        visit(root.current);
      },
    } });
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (...args) {
      const isDecoration = this.canvas instanceof HTMLCanvasElement &&
        this.canvas.closest('[data-test-class~="composer-decoration-scene"]');
      const start = performance.now();
      draw.apply(this, args);
      if (isDecoration) {
        target.__decorationProbe.draws++;
        target.__decorationProbe.drawMs.push(performance.now() - start);
      }
    };
  });
}

export async function resetDecorationProbe(page: Page) {
  await page.evaluate(() => (window as unknown as ProbeWindow).__resetDecorationProbe());
}
export async function readDecorationProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => (window as unknown as ProbeWindow).__decorationProbe);
}
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, meanMs: values.reduce((a, b) => a + b, 0) / (values.length || 1),
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0, maxMs: sorted.at(-1) ?? 0 };
}
