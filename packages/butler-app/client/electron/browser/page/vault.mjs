// Runs in a frame's isolated world (9001) beside a serialized `vaultKind`.
// Answers field kinds, page facts and short-lived refs; never a field value.

/** Field targets, steps only the user can do, and the amount a page shows. */
export function vaultScan({ sectionRef, markers, targets: requested }) {
  const refs = globalThis.__butlerVaultRefs = new Map();
  let next = 0;
  const keep = element => { const id = `v${++next}`; refs.set(id, new WeakRef(element)); return id; };
  const shown = element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return box.width >= 2 && box.height >= 2 && style.visibility !== "hidden" && style.display !== "none";
  };
  const labelOf = node => `${node?.id ?? ""} ${node?.getAttribute?.("class") ?? ""} ${node?.getAttribute?.("name") ?? ""}`.toLowerCase();
  const marked = element => { for (let node = element; node; node = node.parentElement) if (markers.some(marker => labelOf(node).includes(marker))) return true; return false; };
  let root = document;
  if (sectionRef) {
    const anchor = globalThis.__butlerObservation?.refs?.get(sectionRef)?.deref();
    if (!anchor?.isConnected) return { origin: location.origin, url: location.href, section: "missing", targets: [] };
    root = anchor;
    while (root.parentElement && [...root.querySelectorAll("input,select")].filter(element => vaultKind(element)).length < 2) root = root.parentElement;
  }
  const mapped = new Map(), incompatible = [];
  if (Array.isArray(requested)) for (const target of requested) {
    const element = globalThis.__butlerObservation?.refs?.get(target.ref)?.deref();
    if (!element?.isConnected) continue;
    const sensitive = ["passport_number", "birth_date", "rrn"].includes(target.field);
    const detected = vaultKind(element, sensitive);
    if (sensitive && (detected !== (target.field === "birth_date" ? "birth" : target.field)
      || !["text", "password", "number", "date", "select-one"].includes(element.type)
      || ["email", "tel", "url", "search"].includes(element.inputMode)
      || element.type === "date" && target.field !== "birth_date")) {
      incompatible.push({ ref: target.ref, field: target.field, detected });
      continue;
    }
    if (element?.isConnected && ["input", "select", "textarea"].includes(element.localName)
      && !["number", "cvc", "name", "expiry", "exp_month", "exp_year", "pin_short"].includes(vaultKind(element))
      && (element.type !== "password" || ["passport_number", "birth_date", "rrn"].includes(target.field))) mapped.set(element, target.field);
  }
  if (incompatible.length) return { origin: location.origin, targets: [], incompatible };
  const controls = (Array.isArray(requested) ? [...mapped.keys()] : [...root.querySelectorAll("input,select")]).filter(element => !element.disabled && shown(element));
  const keyImages = [...document.querySelectorAll('img,input[type="image"],[style*="background"]')]
    .filter(node => /key|pad|kbd/u.test(`${labelOf(node)} ${labelOf(node.parentElement)}`)).length;
  const cardContext = element => [...(element.closest("form") ?? document).querySelectorAll("input")].some(input => ["number", "cvc"].includes(vaultKind(input)));
  const targets = [];
  for (const element of controls) {
    const kind = mapped.get(element) ?? vaultKind(element);
    if (!kind) continue;
    const keypad = marked(element) || element.readOnly && element.type === "password" && keyImages >= 10;
    targets.push({ id: keep(element), kind, tag: element.localName, type: (element.type ?? "").toLowerCase(),
      max: element.maxLength > 0 ? element.maxLength : 0, placeholder: (element.getAttribute("placeholder") ?? "").slice(0, 24),
      value: element.type === "radio" ? `${element.value} ${element.labels?.[0]?.textContent ?? ""}`.trim().slice(0, 40) : undefined,
      empty: !element.value, readOnly: element.readOnly, keypad, card: cardContext(element),
      options: element.localName === "select" ? [...element.options].slice(0, 300).map(option => [option.value, option.textContent.trim().slice(0, 40)]) : undefined });
  }
  const genders = (requested ? [] : [...root.querySelectorAll('input[type="radio"]')]).filter(input => shown(input) && /gender|sex|성별/iu.test(`${input.name} ${input.id}`));
  for (const input of genders) targets.push({ id: keep(input), kind: "gender", tag: "radio", value: `${input.value} ${input.labels?.[0]?.textContent ?? ""}`.trim().slice(0, 40), empty: !genders.some(item => item.checked) });
  const text = (document.body?.innerText ?? "").slice(0, 20000);
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const otp = inputs.some(input => !vaultKind(input) && (/one-time-code/u.test(input.autocomplete ?? "") || /(^|[^a-z])(otp|sms)([^a-z]|$)|verification.?code|auth.?code|인증.?번호|승인.?번호/iu.test(`${input.id} ${input.name} ${input.placeholder ?? ""} ${input.getAttribute("aria-label") ?? ""} ${input.labels?.[0]?.textContent ?? ""}`)));
  const threeDs = Boolean(document.querySelector('input[name="PaReq" i],input[name="creq" i],input[name="threeDSSessionData" i],input[name="TermUrl" i]'))
    || /(^|[^a-z])(acs|3ds|3dsecure|threeds|secure3d)([^a-z]|$)/iu.test(location.pathname + location.hostname)
    || /3-?D\s?Secure|Verified by Visa|ID Check|SafeKey|안심\s?클릭/iu.test(text);
  const appAuth = !targets.some(target => target.kind === "number") && /앱\s?카드|app\s?card|(^|[^a-z])ISP([^a-z]|$)|페이북|paybooc|QR\s?(코드|code)|카드사\s?앱|scan the qr/iu.test(text);
  const captcha = Boolean(document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[src*="turnstile"],.g-recaptcha,.h-captcha,.cf-turnstile,img[src*="captcha"]'));
  const keypad = targets.some(target => target.keypad) || inputs.some(input => marked(input));
  const human = captcha ? "captcha" : threeDs ? "three_ds" : otp ? "otp" : appAuth && !targets.length ? "app_auth" : null;
  const amount = /(총\s*결제\s*금액|최종\s*결제\s*금액|결제\s*금액|결제\s*예정\s*금액|총\s*금액|합계|grand\s*total|order\s*total|total\s*due|amount\s*due|total)[^0-9₩$€¥£]{0,24}([₩$€¥£]\s?[0-9]{1,3}(?:[,.][0-9]{3})*(?:\.[0-9]{2})?|[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?\s?(?:원|KRW|USD|EUR|JPY)?|[0-9]+\s?(?:원|KRW|USD|EUR|JPY))/iu.exec(text)?.[2]?.trim().slice(0, 32) ?? null;
  return { origin: location.origin, url: location.href, targets, human, keypad, amount };
}

/** Focuses a target (scrolled into view, its text selected so typing replaces it). */
export function vaultFocus({ id }) {
  const element = globalThis.__butlerVaultRefs?.get(id)?.deref();
  if (!element?.isConnected) return { ok: false };
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.focus();
  try { element.select?.(); } catch { /* number inputs have no selection */ }
  const box = element.getBoundingClientRect();
  return { ok: true, focused: element.ownerDocument.activeElement === element && document.hasFocus(),
    rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
}

/** Sets a select, radio or date control (values here are never card numbers or CVCs). */
export function vaultChoose({ id, value }) {
  const element = globalThis.__butlerVaultRefs?.get(id)?.deref();
  if (!element?.isConnected) return { ok: false };
  if (element.type === "radio") element.click();
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: element.type === "radio" ? element.checked : element.value === value };
}

/** Marks the targets that now hold a value as filled (hidden from observations
 * and masked in screenshots) and ends editing so the page validates them. */
export function vaultMark({ ids }) {
  const filled = globalThis.__butlerVaultFilled ??= new WeakSet();
  const done = [];
  for (const id of ids) {
    const element = globalThis.__butlerVaultRefs?.get(id)?.deref();
    if (element?.isConnected && (element.type === "radio" ? element.checked : element.value.length > 0)) { filled.add(element); done.push(id); }
  }
  document.activeElement?.blur?.();
  return done;
}
