/** Enhances server-rendered Tabs: selection, arrow-key roving focus and ARIA ids. */
let counter = 0;

function enhance(root: HTMLElement) {
  root.dataset.enhanced = "true";
  const id = `tabs-${(counter += 1)}`;
  const triggers = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .filter((trigger) => trigger.closest('[data-slot="tabs"]') === root);
  const panels = [...root.querySelectorAll<HTMLElement>('[data-slot="tabs-panel"]')]
    .filter((panel) => panel.closest('[data-slot="tabs"]') === root);
  for (const trigger of triggers) {
    const value = trigger.dataset.value ?? "";
    const panel = panels.find((candidate) => candidate.dataset.value === value);
    trigger.id = `${id}-tab-${value}`;
    if (panel) {
      panel.id = `${id}-panel-${value}`;
      panel.setAttribute("aria-labelledby", trigger.id);
      trigger.setAttribute("aria-controls", panel.id);
    }
  }
  const select = (next: HTMLButtonElement, focus: boolean) => {
    for (const trigger of triggers) {
      const active = trigger === next;
      trigger.setAttribute("aria-selected", String(active));
      trigger.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.value !== next.dataset.value;
    if (focus) next.focus();
  };
  const initial = triggers.find((trigger) => trigger.getAttribute("aria-selected") === "true") ?? triggers[0];
  if (initial) select(initial, false);
  root.addEventListener("click", (event) => {
    const trigger = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]');
    if (trigger && triggers.includes(trigger)) select(trigger, false);
  });
  root.addEventListener("keydown", (event) => {
    const current = triggers.indexOf(event.target as HTMLButtonElement);
    if (current === -1) return;
    const last = triggers.length - 1;
    const next = { ArrowRight: current === last ? 0 : current + 1, ArrowLeft: current === 0 ? last : current - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(triggers[next], true);
  });
}

export function enhanceTabs(scope: ParentNode = document) {
  for (const root of scope.querySelectorAll<HTMLElement>('[data-slot="tabs"]:not([data-enhanced])')) enhance(root);
}
