export interface TextSizeMain {
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

/** Native input coordinates are DIPs, while measured DOM rectangles are CSS pixels. */
export function textSizeDriver(main: TextSizeMain, windowExpression: string) {
  const contents = `${windowExpression}.webContents`;
  const expression = <T>(code: string): Promise<T> => main.evaluate(`${contents}.executeJavaScript(${JSON.stringify(code)})`);
  const clickSelector = async (selector: string, label?: string) => {
    const point = await expression<{ x: number; y: number }>(`(()=>{
      const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];
      const node=nodes.find(e=>e.checkVisibility() && ${label ? `(e.getAttribute('aria-label')||e.textContent)?.trim()===${JSON.stringify(label)}` : 'true'});
      if(!node || node.disabled || node.getAttribute('aria-disabled')==='true')throw Error('Unavailable control');
      node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2;
      if(!node.contains(document.elementFromPoint(x,y)))throw Error('Control is not hit-testable');
      return {x,y};
    })()`);
    await main.evaluate(`(()=>{const wc=${contents},z=wc.getZoomFactor(),p={x:Math.round(${point.x}*z),y:Math.round(${point.y}*z),button:'left',clickCount:1};
      wc.sendInputEvent({type:'mouseDown',...p});wc.sendInputEvent({type:'mouseUp',...p});})()`);
  };
  return {
    expression,
    evaluate<T>(fn: () => T): Promise<Awaited<T>> { return expression(`(${fn.toString()})()`); },
    clickSelector,
    clickText: (label: string, selector: string) => clickSelector(selector, label),
    insertText: (text: string) => main.evaluate<void>(`${contents}.insertText(${JSON.stringify(text)})`),
    press: (key: string) => main.evaluate<void>(`${contents}.sendInputEvent({type:'keyDown',keyCode:${JSON.stringify(key)}});${contents}.sendInputEvent({type:'keyUp',keyCode:${JSON.stringify(key)}})`),
    async waitForFunction(fn: () => unknown) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await expression(`(${fn.toString()})()`)) return;
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error(`App did not become ready: ${fn.toString()}`);
    },
    close() {},
  };
}
export type TextSizePage = ReturnType<typeof textSizeDriver>;
