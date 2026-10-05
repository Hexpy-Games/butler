import type { LifecycleCopy } from "../../../../../../butler-i18n/src/lifecycle";
import type { startMarkLoop } from "../../libs/design-system/components/ButlerThinkingMark/markLoop";
type State = { kind?: string; state?: string; stage?: string; theme?: "light" | "dark"; locale?: string; motion?: string; reducedMotion?: boolean; forceQuit?: boolean; failedStage?: string; copy: { ko: LifecycleCopy; en: LifecycleCopy } };
type Bridge = { state(): Promise<State>; action(action: string): void; onState(listener: (state: Partial<State>) => void): void; painted(): void };
const runtime = window as unknown as { butlerLifecycle?: Bridge; startMarkLoop: typeof startMarkLoop };

const slots = Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>("[data-slot]"), (element) => [element.dataset.slot!, element]));
const canvas = document.querySelector<HTMLCanvasElement>('[data-slot="mark"]')!;
const sim: Parameters<typeof startMarkLoop>[1]["sim"] = { current: null };
const query = new URLSearchParams(location.search);
let current = Object.fromEntries(query) as unknown as State;
let working = false;
let reduced = false;
let loop: { start(): void; dispose(): void } | null;
const bridge = runtime.butlerLifecycle;
const classes = JSON.parse(document.documentElement.dataset.classes!);
const lineFrame = slots.line!.parentElement!;
const title = slots.title!;

function apply(next: Partial<State>) {
  const previousTheme = current.theme;
  current = { ...current, ...next };
  const { kind = "startup", state, stage = kind === "startup" ? "prepare" : "saving", theme = "light", locale = "en", failedStage, forceQuit } = current;
  reduced = current.motion === "reduced" || current.reducedMotion === true || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const copy = locale.startsWith("ko") ? current.copy.ko : current.copy.en;
  const c = kind === "startup" ? copy.startup : copy.quit;
  const failed = state === "error" || state === "failed";
  const slow = state === "slow" || state === "timeout";
  const force = kind === "quit" && forceQuit === true;
  working = !failed;
  document.documentElement.className = `theme-${theme}`;
  document.documentElement.lang = locale.startsWith("ko") ? "ko" : "en";
  document.documentElement.dataset.motion = reduced ? "reduced" : "auto";
  document.title = c.title;
  const values = {
    title: failed ? c.failed : c.title,
    line: failed ? "" : (c.stage as Record<string, string>)[stage],
    detail: failed ? kind === "startup" ? copy.startup.reason[failedStage === "screen" ? "screen" : ["data", "upgrade"].includes(failedStage ?? "") ? "data" : "service"] : force ? copy.quit.forceHint : "" : "",
    caption: slow && !force ? copy.slow : "",
    secondary: failed || kind === "quit" && slow ? copy.action.openLog : "",
    primary: failed && kind === "startup" ? copy.action.retry : force && (failed || slow) ? copy.action.forceQuit : "",
  };
  for (const [name, value] of Object.entries(values)) {
    const element = slots[name]!;
    if (name === "line" && element.textContent !== value && !reduced && document.documentElement.dataset.painted === "true") {
      const outgoing = lineFrame.cloneNode(true) as HTMLElement;
      outgoing.removeAttribute("data-slot");
      outgoing.querySelector("[data-slot]")?.removeAttribute("data-slot");
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.className = classes.outgoing;
      lineFrame.before(outgoing);
      outgoing.addEventListener("animationend", () => outgoing.remove(), { once: true });
      lineFrame.className = classes.incoming;
    }
    element.textContent = value ?? "";
    element.hidden = !value;
  }
  lineFrame.parentElement!.parentElement!.hidden = failed;
  slots.actions!.hidden = !values.secondary;
  title.setAttribute("role", failed ? "alert" : "heading");
  slots.primary!.className = force ? classes.destructive : classes.primary;
  if (force) { slots.primary!.setAttribute("aria-description", copy.quit.forceHint); slots.primary!.title = copy.quit.forceHint; }
  if (!loop || previousTheme !== theme) {
    loop?.dispose();
    loop = runtime.startMarkLoop(canvas, { theme, isWorking: () => working, isReduced: () => reduced, sim });
  }
  canvas.dataset.breathe = reduced && working ? "on" : "";
  loop?.start();
  if (failed) (values.primary ? slots.primary : slots.secondary)!.focus();
}
slots.secondary!.onclick = () => bridge?.action("log");
slots.primary!.onclick = () => bridge?.action(current.kind === "quit" ? "force" : "retry");
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && current.kind === "startup" && current.state === "error") bridge?.action("quit"); });
Object.assign(window, { lifecycleState: apply });
bridge?.onState(apply);
void (async () => {
  if (bridge) apply(await bridge.state());
  if (query.get("still")) {
    const image = document.createElement("img");
    image.alt = "";
    image.className = classes.backdrop;
    image.src = query.get("still")!;
    document.querySelector("[data-surface=base]")!.prepend(image);
    await image.decode().catch(() => image.remove());
  }
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  document.documentElement.dataset.painted = "true";
  bridge?.painted();
})();
