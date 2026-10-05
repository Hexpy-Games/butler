import type { Page } from "playwright";

type Fiber = {
  type: unknown;
  stateNode: unknown;
  flags: number;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: unknown;
  alternate: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
};
type RenderProbeWindow = Window & {
  __composerRenders: Record<string, number>;
  __REACT_DEVTOOLS_GLOBAL_HOOK__: {
    supportsFiber: boolean;
    inject(): number;
    onCommitFiberRoot(id: number, root: { current: Fiber }): void;
    onCommitFiberUnmount(): void;
  };
};

/** DevTools commit hook for the composer shell and all visible surrounding regions. */
export async function installComposerRenderProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as RenderProbeWindow;
    const seen = new WeakMap<Fiber, { props: Fiber["memoizedProps"]; state: unknown }>();
    target.__composerRenders = {};
    const visit = (fiber: Fiber | null, outsideRegion?: string) => {
      if (!fiber) return;
      const prior = seen.get(fiber) ?? (fiber.alternate ? seen.get(fiber.alternate) : undefined);
      const changed = !prior || prior.props !== fiber.memoizedProps || prior.state !== fiber.memoizedState;
      const marker = fiber.memoizedProps?.["data-test-class"];
      if (changed && (fiber.flags & 1) && typeof fiber.type === "function" && fiber.memoizedProps?.dataTestClass === "composer-controls") {
        target.__composerRenders["composer-controls-row"] = (target.__composerRenders["composer-controls-row"] ?? 0) + 1;
      }
      if (changed && (fiber.flags & 1) && typeof fiber.type === "function" && fiber.memoizedProps?.onReserveChange) {
        target.__composerRenders["composer-shell"] = (target.__composerRenders["composer-shell"] ?? 0) + 1;
      }
      const region = typeof marker === "string" && /^(app-sidebar|message-list|conversation-scroll|titlebar)/u.test(marker)
        ? marker.split(" ")[0] : outsideRegion;
      if (region && changed && (fiber.flags & 1) && typeof fiber.type === "function") {
        const key = `outside:${region}:${fiber.type.name}`;
        target.__composerRenders[key] = (target.__composerRenders[key] ?? 0) + 1;
      }
      if (changed && (fiber.flags & 1) && typeof fiber.type === "function" &&
          (marker === "context-donut-button" || marker === "model-button")) {
        target.__composerRenders[marker] = (target.__composerRenders[marker] ?? 0) + 1;
        if (marker === "context-donut-button") {
          if (!prior || prior.props?.ratio === fiber.memoizedProps?.ratio) {
            const unchanged = "context-donut-button-unchanged";
            target.__composerRenders[unchanged] = (target.__composerRenders[unchanged] ?? 0) + 1;
          }
        }
      }
      const snapshot = { props: fiber.memoizedProps, state: fiber.memoizedState };
      seen.set(fiber, snapshot);
      if (fiber.alternate) seen.set(fiber.alternate, snapshot);
      visit(fiber.child, region);
      visit(fiber.sibling, outsideRegion);
    };
    target.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: (_id, root) => visit(root.current),
      onCommitFiberUnmount: () => undefined,
    };
  });
}

export async function resetComposerRenderProbe(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as RenderProbeWindow).__composerRenders = {}; });
}

export async function readComposerRenderProbe(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => (window as unknown as RenderProbeWindow).__composerRenders);
}
