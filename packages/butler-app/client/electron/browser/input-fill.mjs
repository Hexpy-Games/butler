import { evaluateWorld, frameWorlds } from "./frame-worlds.mjs";
import { dispatchKey, parseChord } from "./keyboard.mjs";
import { detectSource, evaluate, settled, type } from "./signin-fill.mjs";

const KINDS = ["username", "password", "otp"];

async function detected(tab) {
  if (tab.profile !== "signed_in" || !tab.view || tab.status === "crashed") return { fields: [] };
  const page = await evaluate(tab, detectSource(tab.policy?.secure_keypads ?? []));
  const offer = tab.saveOffer;
  return {
    status: "ok", origin: page.origin,
    fields: KINDS.filter(kind => page[kind] && (kind !== "otp" || !page.keypad)),
    live: page.keypad || page.captcha,
    save_offer: offer ? { username: offer.username, host: new URL(offer.origin).host } : null,
  };
}

export async function inputFields(tab) {
  if (tab.inputBusy) return { status: "input_busy" };
  return detected(tab);
}

export async function fillInputs(browser, tab, token) {
  if (tab.inputBusy) return { status: "input_busy" };
  if (tab.profile !== "signed_in" || tab.holder !== "user" || !tab.waiting || !tab.view || tab.status === "crashed")
    return { status: "input_unavailable" };
  tab.inputBusy = true;
  try {
    const contents = tab.view.webContents;
    const url = contents.getURL(), origin = new URL(url).origin;
    contents.focus();
    const page = await evaluate(tab, detectSource(tab.policy?.secure_keypads ?? []));
    if (page.origin !== origin) return { status: "origin_mismatch" };
    const values = await browser.pullInput(token, origin);
    if (!values || values.error) return { status: values?.error === "origin_mismatch" ? "origin_mismatch" : "input_unavailable" };
    let typed = false;
    for (const kind of KINDS) {
      if (!values[kind] || !page[kind] || kind === "otp" && page.keypad) continue;
      if (tab.holder !== "user" || !tab.waiting) return { status: "input_unavailable" };
      if (new URL(contents.getURL()).origin !== origin) return { status: "origin_mismatch" };
      const filled = await type(tab, page[kind], values[kind], kind === "password");
      values[kind] = null;
      if (!filled) continue;
      typed = true;
      tab.readsClosed ??= { inPage: url };
      for (const frame of await frameWorlds(tab)) {
        if (await evaluateWorld(frame, `(()=>{if(!document.hasFocus())return false;
          const e=document.activeElement;if(e?.localName!=="input"||!e.value)return false;
          (globalThis.__butlerVaultFilled ??= new WeakSet()).add(e);return true;})()`)) break;
      }
      tab.vaultFilled = true;
    }
    if (!typed) return { status: "no_fields" };
    const beforeEnter = contents.getURL();
    await dispatchKey(tab, parseChord("Enter"));
    await settled(tab, 6000);
    if (tab.offerCheck) {
      let timer;
      try {
        await Promise.race([tab.offerCheck, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
      } finally { clearTimeout(timer); }
    }
    return { ...await detected(tab), status: "filled", navigated: contents.getURL() !== beforeEnter };
  } finally { tab.inputBusy = false; }
}
