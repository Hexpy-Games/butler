// Runs in each observed frame's isolated world with the perception helpers installed.
export function focusTarget({ key }) {
  if (!document.hasFocus()) return null;
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (element && /^(iframe|frame)$/u.test(element.localName)) return null;
  if (!element || element === document.body || element === document.documentElement) return { hit: { role: "document", name: document.title, frame: location.hostname } };
  const meaning = semantic(element, false), hit = { role: meaning.role || element.localName, name: meaning.name ?? "", frame: location.hostname };
  for (const [ref, weak] of globalThis.__butlerObservation?.refs ?? []) if (weak.deref() === element) { hit.ref = ref; break; }
  if (meaning.secure || secureKeypad(element) || element.type === "password") return { reason: "secure_field", hit };
  const form = element.form ?? element.closest("form");
  return { hit, payment: Boolean(form?.querySelector('[autocomplete="cc-number"],[autocomplete="cc-csc"]')),
    upload: element.localName === "input" && element.type === "file" && /^(Enter|Space)$/u.test(key ?? ""),
    submit: key === "Enter" && Boolean(form) || element.type === "submit" && /^(Enter|Space)$/u.test(key ?? "") };
}
