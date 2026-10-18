// Korean 2-beolsik IME models for composer smokes.
// `hangulAutomaton` is self-contained so it also runs inside Firefox's chrome context.
import type { Marionette } from "./firefox-marionette.ts";

export type ImeKeyResult = { commit: string; compose: string; literal: string };

/** One syllable buffer; each key may commit the previous syllable and start the next. */
export function hangulAutomaton() {
  const initials = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const vowels = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
  const finals = ["", ..."ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"];
  let l = -1; let v = -1; let t = 0;
  const text = () => l >= 0 && v >= 0 ? String.fromCharCode(0xac00 + (l * 21 + v) * 28 + t)
    : l >= 0 ? initials[l] : v >= 0 ? vowels[v] : "";
  const reset = () => { l = -1; v = -1; t = 0; };
  return {
    text,
    reset,
    press(key: string): ImeKeyResult {
      let commit = "";
      if (vowels.includes(key)) {
        if (l >= 0 && v < 0) v = vowels.indexOf(key);
        else if (t > 0) { const moved = initials.indexOf(finals[t]); t = 0; commit = text(); l = moved; v = vowels.indexOf(key); }
        else { commit = text(); l = -1; t = 0; v = vowels.indexOf(key); }
      } else if (initials.includes(key)) {
        if (l >= 0 && v >= 0 && t === 0 && finals.indexOf(key) > 0) t = finals.indexOf(key);
        else { commit = text(); l = initials.indexOf(key); v = -1; t = 0; }
      } else { commit = text(); reset(); return { commit, compose: "", literal: key }; }
      return { commit, compose: text(), literal: "" };
    },
  };
}

/** "한글 테스트" -> ㅎㅏㄴㄱㅡㄹ ㅌㅔㅅㅡㅌㅡ (the keys a 2-beolsik typist presses). */
export function hangulKeys(text: string): string[] {
  const initials = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const vowels = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
  const finals = ["", ..."ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"];
  return [...text].flatMap((char) => {
    const code = char.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) return [char];
    return [initials[Math.floor(code / 588)], vowels[Math.floor((code % 588) / 28)], finals[code % 28]].filter(Boolean);
  });
}

// Gecko TextInputProcessor with the commit policy of Android's GeckoEditable and
// Windows TSF Korean IMEs: a text or selection change that the composition did not
// cause makes the IME commit its composition and restart its syllable buffer.
const FIREFOX_IME = (automaton: string) => `
const win = Services.wm.getMostRecentWindow("navigator:browser");
const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
const ime = (${automaton})();
const external = [];
const callback = (aTip, note) => {
  if (note.type === "request-to-commit") { if (aTip.hasComposition) aTip.commitComposition(); ime.reset(); return true; }
  if (note.type === "request-to-cancel") { if (aTip.hasComposition) aTip.cancelComposition(); ime.reset(); return true; }
  const foreign = (note.type === "notify-text-change" && !note.causedOnlyByComposition) ||
    (note.type === "notify-selection-change" && !note.causedByComposition && !note.causedBySelectionEvent);
  if (foreign && aTip.hasComposition) {
    external.push(note.type + (note.type === "notify-text-change" ? " offset=" + note.offset + " removed=" + note.removedLength + " added=" + note.addedLength : " offset=" + note.offset));
    Services.tm.dispatchToMainThread(() => { if (tip.hasComposition) tip.commitComposition(); ime.reset(); });
  }
  return true;
};
if (!tip.beginInputTransactionForTests(win, callback)) throw new Error("TextInputProcessor transaction refused");
const key = (k, code, keyCode) => new win.KeyboardEvent("", { key: k, code, keyCode });
// The platform's shortcut modifier, as for a person at that keyboard.
const modifier = Services.appinfo.OS === "Darwin" ? key("Meta", "MetaLeft", 224) : key("Control", "ControlLeft", 17);
const compose = (text, event) => {
  tip.setPendingCompositionString(text);
  tip.appendClauseToPendingComposition(text.length, tip.ATTR_RAW_CLAUSE);
  tip.setCaretInPendingComposition(text.length);
  tip.flushPendingComposition(event);
};
globalThis.__butlerIme = {
  press(k) {
    const step = ime.press(k);
    const processKey = key("Process", "KeyA", 229);
    if (step.literal) {
      if (tip.hasComposition) tip.commitCompositionWith(step.commit);
      globalThis.__butlerIme.type(step.literal);
    } else if (step.commit && tip.hasComposition) { tip.commitCompositionWith(step.commit, processKey); compose(step.compose); }
    else compose(step.compose, processKey);
    return tip.hasComposition;
  },
  commit() { if (tip.hasComposition) tip.commitCompositionWith(ime.text()); ime.reset(); return true; },
  type(text) {
    for (const ch of text) {
      const e = ch === " " ? key(" ", "Space", 32) : key(ch, "Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0));
      tip.keydown(e); tip.keyup(e);
    }
    return true;
  },
  clear() {
    const a = key("a", "KeyA", 65); const backspace = key("Backspace", "Backspace", 8);
    tip.keydown(modifier); tip.keydown(a); tip.keyup(a); tip.keyup(modifier);
    tip.keydown(backspace); tip.keyup(backspace);
    return true;
  },
  enter(withModifier) {
    const enter = key("Enter", "Enter", 13);
    if (withModifier) tip.keydown(modifier);
    tip.keydown(enter); tip.keyup(enter);
    if (withModifier) tip.keyup(modifier);
    return true;
  },
  external(reset) { const out = external.slice(); if (reset) external.length = 0; return out; },
};
return true;
`;

export type FirefoxIme = { press(key: string): Promise<void>; commit(): Promise<void>; type(text: string): Promise<void>; clear(): Promise<void>; enter(withModifier: boolean): Promise<void>; external(): Promise<string[]> };

export async function installFirefoxIme(marionette: Marionette): Promise<FirefoxIme> {
  await marionette.run("chrome", FIREFOX_IME(hangulAutomaton.toString()));
  return {
    press: async (key) => { await marionette.run("chrome", "return globalThis.__butlerIme.press(arguments[0])", [key]); },
    commit: async () => { await marionette.run("chrome", "return globalThis.__butlerIme.commit()"); },
    type: async (text) => { await marionette.run("chrome", "return globalThis.__butlerIme.type(arguments[0])", [text]); },
    clear: async () => { await marionette.run("chrome", "return globalThis.__butlerIme.clear()"); },
    enter: async (withModifier) => { await marionette.run("chrome", "return globalThis.__butlerIme.enter(arguments[0])", [withModifier]); },
    external: () => marionette.run<string[]>("chrome", "return globalThis.__butlerIme.external(true)"),
  };
}
