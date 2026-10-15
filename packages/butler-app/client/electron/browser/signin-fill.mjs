import { dispatchKey, parseChord } from "./keyboard.mjs";
import { signedInPlace } from "./signed-in.mjs";

/** Sign-in fill (spec §9.3). Main checks the top-level origin against the
 * entry's exact login origins and that the fields sit in the main frame or a
 * same-origin frame, pulls the password once with the single-use token,
 * types it with insertText and drops it. Results never carry a value. */

// Isolated world 9002 so page scripts and the perception world never see the refs.
const WORLD = 9002;

/** Visible sign-in controls of the page and its same-origin frames, by kind. */
function detectSource(markers) {
  return `(()=>{const markers=${JSON.stringify(markers)};
  const refs=globalThis.__butlerSignIn=new Map();let next=0;const keep=e=>{const id='s'+(++next);refs.set(id,new WeakRef(e));return id};
  const docs=[document];for(let i=0;i<docs.length;i++)for(const f of docs[i].querySelectorAll('iframe,frame')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch{}}
  const shown=e=>{const v=e.ownerDocument.defaultView,s=v.getComputedStyle(e),r=e.getBoundingClientRect();return r.width>=4&&r.height>=4&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)>=0.1};
  const label=e=>((e.id||'')+' '+(e.getAttribute('name')||'')+' '+(e.getAttribute('class')||'')+' '+(e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')).toLowerCase();
  const marked=e=>{for(let n=e;n;n=n.parentElement){const l=label(n);if(markers.some(m=>l.includes(m)))return true}return false};
  const inputs=docs.flatMap(d=>[...d.querySelectorAll('input')]).filter(e=>!e.disabled&&shown(e));
  const text=inputs.filter(e=>/^(text|email|tel|)$/u.test(e.type)&&!e.readOnly);
  const scripts=docs.flatMap(d=>[...d.scripts].map(s=>(s.src||'').toLowerCase()));
  const keyImages=docs.flatMap(d=>[...d.querySelectorAll('img,input[type=image],[style*="background"]')]).filter(e=>shown(e)&&/key|pad|kbd/u.test(label(e)+' '+label(e.parentElement||e)));
  const keypad=inputs.some(e=>marked(e))||inputs.some(e=>e.readOnly&&(e.type==='password'||/pw|pass|pin|비밀/u.test(label(e))))&&keyImages.length>=10||scripts.some(s=>markers.some(m=>s.includes(m)))&&inputs.some(e=>e.type==='password');
  const otp=inputs.find(e=>/one-time-code/u.test(e.autocomplete||'')||!e.readOnly&&/(^|[^a-z])(otp|2fa|mfa|totp)([^a-z]|$)|verification.?code|auth.?code|one.?time|인증.?번호|보안.?코드/u.test(label(e)));
  const captcha=docs.some(d=>d.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[src*="turnstile"],.g-recaptcha,.h-captcha,.cf-turnstile,img[src*="captcha"]'))||inputs.some(e=>/captcha|자동입력.?방지/u.test(label(e)));
  const password=inputs.find(e=>e.type==='password'&&!e.readOnly&&!marked(e));
  const near=password?(password.form?text.filter(e=>e.form===password.form):text.filter(e=>e.ownerDocument===password.ownerDocument)).filter(e=>e.compareDocumentPosition(password)&Node.DOCUMENT_POSITION_FOLLOWING):[];
  const named=e=>/username|email/u.test(e.autocomplete||'')||e.type==='email'||/user|login|email|account|identifier|아이디|이메일/u.test(label(e));
  const username=password?(near.find(named)??near.at(-1)):text.filter(named).length===1&&text.length<=2?text.find(named):undefined;
  const passkey=!password&&inputs.some(e=>/webauthn/u.test(e.autocomplete||''));
  return {password:password?keep(password):null,username:username?keep(username):null,otp:Boolean(otp),captcha,keypad,passkey,inputs:inputs.length,
    origin:location.origin};})()`;
}
const focusSource = (id, password) => `(()=>{const e=globalThis.__butlerSignIn?.get(${JSON.stringify(id)})?.deref();
  if(!e?.isConnected||${password}&&e.type!=='password')return false;e.focus();if(typeof e.select==='function')e.select();
  return e.ownerDocument.activeElement===e&&(e.ownerDocument===document||document.activeElement===e.ownerDocument.defaultView.frameElement)})()`;
const filledSource = id => `(()=>{const e=globalThis.__butlerSignIn?.get(${JSON.stringify(id)})?.deref();return Boolean(e?.isConnected&&e.value.length>0)})()`;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(tab, code) { return tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); }
async function settled(tab, maxMs) {
  const deadline = Date.now() + maxMs, contents = tab.view.webContents;
  await pause(150);
  while (contents.isLoading() && Date.now() < deadline) await pause(100);
  await pause(250);
}
async function type(tab, id, text, password) {
  if (!await evaluate(tab, focusSource(id, password))) return false;
  tab.expectedInputs = [];
  await tab.view.webContents.insertText(text);
  return evaluate(tab, filledSource(id));
}
function humanStep(state) {
  if (state.keypad) return "secure_keypad";
  if (state.captcha) return "captcha";
  if (state.otp) return "mfa";
  if (state.passkey) return "passkey";
  return null;
}

/** One fill: up to three rounds (username page, password page, what follows). */
export async function fillSignIn(browser, tab, args, controlTab) {
  const contents = tab.view.webContents, origins = Array.isArray(args.origins) ? args.origins : [];
  const handOver = reason => {
    tab.signinStep = reason; controlTab(browser, tab, "user", true);
    return { status: "user_required", reason, tab: tab.id, url: tab.url };
  };
  let submittedPassword = false, typedUsername = false;
  for (let round = 0; round < 3; round++) {
    const origin = new URL(contents.getURL()).origin;
    if (tab.holder !== "agent") return { status: "not_dispatched", reason: "user_control", tab: tab.id };
    if (signedInPlace(contents.getURL(), tab.policy ?? {}) === "denied") return { status: "origin_mismatch", tab: tab.id, url: tab.url };
    // Only the main document and same-origin frames are searched for fields.
    const state = await evaluate(tab, detectSource(tab.policy?.secure_keypads ?? []));
    const step = humanStep(state);
    if (step && (submittedPassword || !state.password || step === "secure_keypad")) return handOver(step);
    if (submittedPassword) return { status: "filled", tab: tab.id, url: contents.getURL() };
    if (!origins.includes(origin)) return { status: "origin_mismatch", tab: tab.id, url: contents.getURL() };
    if (state.password) {
      if (state.username && !await type(tab, state.username, String(args.username ?? ""), false)) return handOver("unknown_form");
      const typed = await typeSecret(browser, tab, state.password, args, origin);
      if (typed !== true) return typed.status === "user_required" ? handOver(typed.reason) : typed;
      // A visible CAPTCHA is the user's to solve before the form is sent.
      if (step === "captcha") return handOver(step);
      submittedPassword = true;
    } else if (state.username && !typedUsername) {
      if (!await type(tab, state.username, String(args.username ?? ""), false)) return handOver("unknown_form");
      typedUsername = true;
    } else if (round === 0) {
      return state.inputs ? handOver("unknown_form") : { status: "no_fields", tab: tab.id, url: contents.getURL() };
    } else return handOver("unknown_form");
    await dispatchKey(tab, parseChord("Enter"));
    await settled(tab, 6000);
  }
  return submittedPassword ? { status: "filled", tab: tab.id, url: contents.getURL() } : handOver("unknown_form");
}

/** Pulls the password once over the authenticated route, types it, drops it. */
async function typeSecret(browser, tab, field, args, origin) {
  if (!await evaluate(tab, focusSource(field, true))) return { status: "user_required", reason: "unknown_form", tab: tab.id };
  const typed = await typePulled(browser, tab, field, String(args.fill_token ?? ""), origin);
  if (typed !== true) return typed;
  return await evaluate(tab, filledSource(field)) ? true : { status: "user_required", reason: "unknown_form", tab: tab.id };
}
/** The password's only reference in main lives in this frame and ends with it. */
async function typePulled(browser, tab, field, token, origin) {
  const pulled = await browser.pullCredential?.(token, origin);
  if (pulled?.error === "origin_mismatch") return { status: "origin_mismatch", tab: tab.id };
  if (typeof pulled?.password !== "string") return { status: "not_dispatched", reason: "credential_unavailable", tab: tab.id };
  if (new URL(tab.view.webContents.getURL()).origin !== origin || !await evaluate(tab, focusSource(field, true))) return { status: "origin_mismatch", tab: tab.id };
  tab.expectedInputs = [];
  await tab.view.webContents.insertText(pulled.password);
  return true;
}
