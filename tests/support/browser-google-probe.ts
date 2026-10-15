// test-category: security
/** Opt-in, one synthetic lookup only. No credentials or repeated submissions. */
export async function googleSigninProbe(contents: any) {
  const read = () => contents.executeJavaScript(`(()=>{
    const text=document.body.innerText;
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>20&&r.height>20&&getComputedStyle(e).visibility!=='hidden'};
    return {url:location.origin+location.pathname,
      email:Boolean(document.querySelector('#identifierId,input[name=identifier],input[type=email]')),
      rejected:location.pathname.includes('/signin/rejected')||text.includes('This browser or app may not be secure'),
      captcha:[...document.querySelectorAll('iframe[src*="recaptcha"],input[name="ca"],#captchaimg')].some(visible)||/verify.{0,20}(human|robot)|로봇이 아님|자동 입력 방지/iu.test(text),
      notFound:/couldn.t find your Google Account|could not find your Google Account|Google 계정을 찾을 수 없/iu.test(text)}
  })()`);
  const deadline = Date.now() + 25_000;
  const until = async (predicate: (state: any) => boolean) => {
    let state;
    do {
      state = await read();
      if (predicate(state)) return state;
      await new Promise(done => setTimeout(done, 100));
    } while (Date.now() < deadline);
    return state;
  };
  let submitted = false;
  let state = await until(s => s.email || s.rejected || s.captcha);
  if (state.email && !state.rejected && !state.captcha) {
    await contents.executeJavaScript("document.querySelector('#identifierId,input[name=identifier],input[type=email]').focus()");
    contents.focus();
    submitted = true;
    await contents.insertText(`butler-probe-${crypto.randomUUID()}@gmail.com`);
    for (const type of ["keyDown", "char", "keyUp"]) contents.sendInputEvent({ type, keyCode: "Enter" });
    state = await until(s => s.rejected || s.captcha || s.notFound);
  }
  return { ...state, submitted, outcome: state.rejected ? "rejected" : state.captcha ? "inconclusive_captcha" : state.notFound ? "account_not_found" : "inconclusive_unknown" };
}
