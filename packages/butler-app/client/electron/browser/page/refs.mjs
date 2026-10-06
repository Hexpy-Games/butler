export function resolveRef({ ref, obs, epoch, scroll = false }) {
  globalThis.__butlerPerceptionCache={styles:new WeakMap(),paint:new WeakMap(),boxes:new WeakMap(),rectangles:new WeakMap(),luminances:new Map()};
  const state = globalThis.__butlerObservation;
  if (!state || state.obs !== obs || state.epoch !== epoch) return { reason: "stale_ref" };
  const element = state.refs.get(ref)?.deref();
  if (!element?.isConnected) return { reason: "stale_ref" };
  if (scroll) {
    const raw=boxOf(element),visible=rectangle(element);
    if (visible.width<raw.width || visible.height<raw.height) {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      globalThis.__butlerPerceptionCache={styles:new WeakMap(),paint:new WeakMap(),boxes:new WeakMap(),rectangles:new WeakMap(),luminances:new Map()};
    }
  }
  const hidden = rendering(element), meaning = semantic(element);
  if (meaning.secure) return { reason: "secure_field" };
  if (hidden) return { reason: hidden === "invisible" ? "transparent_overlay" : "not_actionable" };
  if (element.disabled || element.getAttribute("aria-disabled") === "true") return { reason: "disabled" };
  const point = visiblePoint(element);
  if (point.blocker) return { reason: "blocked_by", hit: semantic(point.blocker) };
  return { x: point.x, y: point.y, hit: { role: meaning.role, name: meaning.name, frame: location.hostname, ref },
    payment: Boolean(element.closest("form")?.querySelector('[autocomplete="cc-number"],[autocomplete="cc-csc"]')),
    addons: currentAddons(),
    upload: element.localName === "input" && element.type === "file",
    submit: element.type === "submit" || /결제|구매|pay|purchase|checkout/iu.test(meaning.name) };
}
export function selectValue({ ref, obs, epoch, value }) {
  const target = resolveRef({ ref, obs, epoch });
  if (target.reason) return target;
  const element = globalThis.__butlerObservation.refs.get(ref).deref();
  if (element.localName !== "select" || ![...element.options].some(option => option.value === value)) return { reason: "invalid_option" };
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { status: "completed", hit: target.hit };
}
