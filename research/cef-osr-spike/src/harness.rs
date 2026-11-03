use crate::{SELF_OK, log, state::Runtime, ui::Spike};

use gpui::*;
use serde_json::{Value, json};
use std::{sync::atomic::Ordering, time::Duration};
pub type Handle = WindowHandle<Spike>;
async fn delay(cx: &AsyncApp, ms: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(ms))
        .await;
}
async fn shot(cx: &AsyncApp, name: &str) {
    delay(cx, 250).await;
    log(
        "shot_request",
        json!({"name":name,"software":crate::flag("--software"),"presentation":crate::presentation::snapshot()}),
    );
    delay(cx, 1200).await;
}
fn dispatch(h: Handle, cx: &mut AsyncApp, event: PlatformInput) {
    let handle: AnyWindowHandle = h.into();
    let _ = handle.update(cx, |_, w, cx| {
        w.dispatch_event(event, cx);
        w.refresh();
    });
}
fn position(rt: &Runtime, x: f32, y: f32) -> gpui::Point<Pixels> {
    rt.shared.borrow().bounds.origin + point(px(x), px(y))
}
fn move_to(h: Handle, rt: &Runtime, cx: &mut AsyncApp, x: f32, y: f32, drag: bool) {
    dispatch(
        h,
        cx,
        PlatformInput::MouseMove(MouseMoveEvent {
            position: position(rt, x, y),
            pressed_button: drag.then_some(MouseButton::Left),
            modifiers: Modifiers::default(),
        }),
    );
}
fn click(h: Handle, rt: &Runtime, cx: &mut AsyncApp, x: f32, y: f32, button: MouseButton) {
    let p = position(rt, x, y);
    dispatch(
        h,
        cx,
        PlatformInput::MouseDown(MouseDownEvent {
            button,
            position: p,
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        }),
    );
    dispatch(
        h,
        cx,
        PlatformInput::MouseUp(MouseUpEvent {
            button,
            position: p,
            modifiers: Modifiers::default(),
            click_count: 1,
        }),
    );
}
fn verdict(name: &str, ok: bool, data: Value, results: &mut Vec<bool>) {
    log(name, json!({"ok":ok,"evidence":data}));
    results.push(ok);
}
async fn rect(rt: &Runtime, selector: &str) -> Value {
    rt.cdp.eval(&rt.host().unwrap(),&format!("(()=>{{let r=document.querySelector({})?.getBoundingClientRect();return r&&{{x:r.x+r.width/2,y:r.y+r.height/2}}}})()",json!(selector)),false).await
}
async fn click_selector(
    h: Handle,
    rt: &Runtime,
    cx: &mut AsyncApp,
    selector: &str,
    button: MouseButton,
) {
    let r = rect(rt, selector).await;
    click(
        h,
        rt,
        cx,
        r["x"].as_f64().unwrap_or(0.) as f32,
        r["y"].as_f64().unwrap_or(0.) as f32,
        button,
    );
    delay(cx, 200).await;
}
pub fn launch(h: Handle, rt: Runtime, cx: &mut App) {
    if crate::flag("--measure") || crate::flag("--raf-only") {
        cx.spawn(async move |cx| crate::perf::run(h, rt, cx).await)
            .detach();
        return;
    }
    let test = crate::flag("--self-test");
    if !test {
        return;
    }
    let timeout = rt.clone();
    cx.spawn(async move |cx| {
        delay(cx, 240000).await;
        if !timeout.shared.borrow().closed {
            log("self_test_timeout", json!(true));
            timeout.close();
        }
    })
    .detach();
    cx.spawn(async move |cx|{
        delay(cx,1400).await;
        if rt.host().is_none() { log("lazy_before_browser",json!({"cef_initialized":false}));let _=rt.start.try_send(());delay(cx,1600).await; }
        log("harness_pump_state",json!({"pumps":rt.shared.borrow().pumps}));
        let host=rt.host().unwrap();
        let ready=rt.cdp.eval(&host,"({ready:document.readyState,title:document.title,scale:devicePixelRatio,width:innerWidth,height:innerHeight})",false).await;
        log("fixture_ready",ready);
        rt.cdp.init_world(&host).await;
        let mut results=vec![];
        shot(cx,"page").await;
        let resized=resize(h,&rt,cx).await;
        if crate::flag("--only-resize") {
            SELF_OK.store(resized,Ordering::SeqCst);log("self_test_result",json!({"ok":resized,"checks":1,"scope":"resize only"}));rt.close();return;
        }
        let viewport=rt.cdp.eval(&host,"({width:innerWidth,height:innerHeight,scale:devicePixelRatio})",false).await;
        let correct={let s=rt.shared.borrow();s.frame.as_ref().is_some_and(|f|f.get_width()==(f32::from(s.bounds.size.width)*s.scale).round() as usize)};
        verdict("resize_scale",correct&&resized,viewport,&mut results);shot(cx,"resize").await;
        let _=h.update(cx,|_,w,_|w.resize(size(px(1200.),px(800.))));delay(cx,500).await;
        let _=h.update(cx,|s,_,cx|{s.popover=true;cx.notify();});shot(cx,"popover").await;
        let _=h.update(cx,|s,_,cx|{s.popover=false;s.page.update(cx,|p,cx|{p.picking=true;cx.notify();});cx.notify();});
        let before=rt.cdp.eval(&host,"window.downs",false).await;
        move_to(h,&rt,cx,100.,40.,false);delay(cx,500).await;shot(cx,"pick").await;
        dispatch(h,cx,PlatformInput::MouseDown(MouseDownEvent{button:MouseButton::Left,position:position(&rt,100.,40.),modifiers:Modifiers::default(),click_count:1,first_mouse:false}));
        move_to(h,&rt,cx,280.,110.,true);delay(cx,200).await;shot(cx,"drag").await;
        let active=cx.update(|cx|cx.active_drag().is_some());
        let target=h.update(cx,|s,_,_|*s.target.borrow()).unwrap();
        dispatch(h,cx,PlatformInput::MouseMove(MouseMoveEvent{position:target.center(),pressed_button:Some(MouseButton::Left),modifiers:Modifiers::default()}));delay(cx,150).await;
        dispatch(h,cx,PlatformInput::MouseUp(MouseUpEvent{button:MouseButton::Left,position:target.center(),modifiers:Modifiers::default(),click_count:1}));delay(cx,700).await;
        let chips=h.update(cx,|s,_,_|s.chips.borrow().clone()).unwrap();
        let after=rt.cdp.eval(&host,"window.downs",false).await;
        verdict("pick_drag_self_test",active&&chips.len()==1&&chips[0]["cropPath"].is_string()&&before==after,json!({"active_drag":active,"chips":chips,"page_downs_before":before,"page_downs_after":after,"routing":"Window::dispatch_event"}),&mut results);
        shot(cx,"chip").await;
        if crate::flag("--only-chip") {
            let ok=results.iter().all(|v|*v);SELF_OK.store(ok,Ordering::SeqCst);log("self_test_result",json!({"ok":ok,"checks":results.len(),"scope":"resize/pick/drag/chip only"}));rt.close();return;
        }
        let _=h.update(cx,|s,_,cx|s.page.update(cx,|p,cx|{p.picking=false;cx.notify();}));
        input_checks(h,&rt,cx,&mut results).await;
        cdp_checks(&rt,cx,&mut results).await;
        if crate::flag("--csp"){csp(&rt,cx,&mut results).await;}
        let ok=results.iter().all(|v|*v);SELF_OK.store(ok,Ordering::SeqCst);
        log("self_test_result",json!({"ok":ok,"checks":results.len(),"passed":results.iter().filter(|v|**v).count(),"real_macos_input":false}));
        rt.close();
    }).detach();
}
async fn input_checks(h: Handle, rt: &Runtime, cx: &mut AsyncApp, results: &mut Vec<bool>) {
    let host = rt.host().unwrap();
    click_selector(h, rt, cx, "#button", MouseButton::Left).await;
    let v = rt.cdp.eval(&host, "window.clicks", false).await;
    verdict("button_click", v == json!(1), v, results);
    click_selector(h, rt, cx, "#text", MouseButton::Left).await;
    let _ = h.update(cx, |s, w, cx| {
        s.page.update(cx, |p, cx| {
            p.replace_and_mark_text_in_range(None, "한", Some(1..1), w, cx);
        })
    });
    delay(cx, 200).await;
    let bounds = rt.shared.borrow().ime_bounds.len();
    let _ = h.update(cx, |s, w, cx| {
        s.page.update(cx, |p, cx| {
            p.replace_and_mark_text_in_range(None, "한글", Some(2..2), w, cx);
            p.replace_text_in_range(None, "한글", w, cx);
            p.unmark_text(w, cx);
        })
    });
    delay(cx, 200).await;
    let v = rt
        .cdp
        .eval(&host, "document.querySelector('#text').value", false)
        .await;
    verdict(
        "korean_ime_routing",
        v == json!("한글"),
        json!({"value":v,"candidate_bounds_count":bounds,"routing":"EntityInputHandler direct composition and commit"}),
        results,
    );
    dispatch(
        h,
        cx,
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse("cmd-a").unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
    );
    delay(cx, 150).await;
    let v = rt
        .cdp
        .eval(
            &host,
            "({start:text.selectionStart,end:text.selectionEnd})",
            false,
        )
        .await;
    verdict("cmd_a", v["start"] == 0 && v["end"] == 2, v, results);
    dispatch(
        h,
        cx,
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse("left").unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
    );
    delay(cx, 150).await;
    let v = rt
        .cdp
        .eval(
            &host,
            "({start:text.selectionStart,end:text.selectionEnd})",
            false,
        )
        .await;
    verdict("arrow_key", v["start"] == v["end"], v, results);
    let _ = h.update(cx, |s, w, cx| {
        let f = s.field.read(cx).focus.clone();
        w.focus(&f, cx);
    });
    delay(cx, 100).await;
    let gf = h
        .update(cx, |s, w, cx| s.field.read(cx).focus.is_focused(w))
        .unwrap();
    click_selector(h, rt, cx, "#text", MouseButton::Left).await;
    let pf = h
        .update(cx, |s, w, cx| s.page.read(cx).focus.is_focused(w))
        .unwrap();
    verdict(
        "focus_round_trip",
        gf && pf,
        json!({"gpui":gf,"page":pf}),
        results,
    );
    click_selector(h, rt, cx, "#select", MouseButton::Left).await;
    shot(cx, "select").await;
    let popup = rt.shared.borrow().popup_show;
    log(
        "select_popup",
        json!({"show":popup,"paint_received":rt.shared.borrow().popup.is_some()}),
    );
    dispatch(
        h,
        cx,
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse("down").unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
    );
    dispatch(
        h,
        cx,
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse("enter").unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
    );
    delay(cx, 200).await;
    let v = rt
        .cdp
        .eval(&host, "document.querySelector('#select').value", false)
        .await;
    verdict(
        "select_input",
        v == json!("Second"),
        json!({"value":v,"popup_painted":popup}),
        results,
    );
    click(h, rt, cx, 150., 60., MouseButton::Right);
    delay(cx, 150).await;
    shot(cx, "context-menu").await;
    let menu = rt.shared.borrow_mut().context.take();
    let shown = menu.is_some();
    if let Some((_, _, _, cb)) = menu {
        use cef::ImplRunContextMenuCallback;
        cb.cancel();
    }
    verdict("context_menu_input", shown, json!({"shown":shown}), results);
    let r = rect(rt, "#nested p").await;
    let x = r["x"].as_f64().unwrap() as f32;
    let y = r["y"].as_f64().unwrap() as f32;
    dispatch(
        h,
        cx,
        PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position: position(rt, x - 100., y),
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        }),
    );
    move_to(h, rt, cx, x + 80., y, true);
    dispatch(
        h,
        cx,
        PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Left,
            position: position(rt, x + 80., y),
            modifiers: Modifiers::default(),
            click_count: 1,
        }),
    );
    delay(cx, 150).await;
    let selection = rt.cdp.eval(&host, "getSelection().toString()", false).await;
    verdict(
        "drag_selection",
        selection.as_str().is_some_and(|s| !s.is_empty()),
        selection,
        results,
    );
    dispatch(
        h,
        cx,
        PlatformInput::ScrollWheel(ScrollWheelEvent {
            position: position(rt, 300., 400.),
            delta: ScrollDelta::Pixels(point(px(0.), px(-220.))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        }),
    );
    delay(cx, 300).await;
    let y = rt.cdp.eval(&host, "scrollY", false).await;
    verdict("wheel", y.as_f64().unwrap_or(0.) > 0., y, results);
    rt.cdp.eval(&host, "scrollTo(0,0)", false).await;
    rt.cdp
        .eval(
            &host,
            "alert('Spike dialog');window.open('about:blank');true",
            false,
        )
        .await;
    click_selector(h, rt, cx, "#file", MouseButton::Left).await;
}
async fn cdp_checks(rt: &Runtime, _cx: &mut AsyncApp, results: &mut Vec<bool>) {
    let host = rt.host().unwrap();
    let snapshot = rt
        .cdp
        .call(
            &host,
            "DOMSnapshot.captureSnapshot",
            json!({"computedStyles":[]}),
        )
        .await;
    verdict(
        "cdp_dom_snapshot",
        snapshot["ok"] == true && snapshot["value"]["documents"].is_array(),
        json!({"documents":snapshot["value"]["documents"].as_array().map(Vec::len),"strings":snapshot["value"]["strings"].as_array().map(Vec::len)}),
        results,
    );
    let dom = rt.cdp.call(&host, "DOM.getDocument", json!({})).await;
    let ax = rt
        .cdp
        .call(
            &host,
            "Accessibility.getPartialAXTree",
            json!({"nodeId":dom["value"]["root"]["nodeId"]}),
        )
        .await;
    verdict(
        "cdp_ax_tree",
        ax["ok"] == true && ax["value"]["nodes"].is_array(),
        json!({"nodes":ax["value"]["nodes"].as_array().map(Vec::len),"native_screen_reader":"not determined"}),
        results,
    );
    let screen = rt
        .cdp
        .call(
            &host,
            "Page.captureScreenshot",
            json!({"format":"png","fromSurface":true}),
        )
        .await;
    verdict(
        "cdp_screenshot",
        screen["ok"] == true,
        json!({"base64_bytes":screen["value"]["data"].as_str().map(str::len)}),
        results,
    );
    let widevine=rt.cdp.eval(&host,r#"navigator.requestMediaKeySystemAccess('com.widevine.alpha',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"'}]}]).then(()=>({supported:true})).catch(e=>({supported:false,name:e.name,message:e.message}))"#,false).await;
    log("widevine_probe", widevine);
    let input = rt
        .cdp
        .call(
            &host,
            "Input.dispatchMouseEvent",
            json!({"type":"mouseMoved","x":60,"y":40}),
        )
        .await;
    verdict("cdp_input", input["ok"] == true, input, results);
    let secret = rt
        .cdp
        .eval(
            &host,
            "globalThis.__spikePrivate=42;typeof __butlerPick",
            true,
        )
        .await;
    let page = rt
        .cdp
        .eval(
            &host,
            "({privateType:typeof __spikePrivate,pickerType:typeof __butlerPick})",
            false,
        )
        .await;
    verdict(
        "world_isolation",
        secret == json!("object")
            && page["privateType"] == "undefined"
            && page["pickerType"] == "undefined",
        json!({"isolated":secret,"page":page}),
        results,
    );
}
async fn csp(rt: &Runtime, cx: &mut AsyncApp, results: &mut Vec<bool>) {
    let host = rt.host().unwrap();
    rt.cdp
        .call(
            &host,
            "Page.navigate",
            json!({"url":"https://github.com/Hexpy-Games/butler"}),
        )
        .await;
    delay(cx, 6000).await;
    let page = rt
        .cdp
        .eval(
            &host,
            "({url:location.href,title:document.title,body:document.body.innerText.slice(0,160)})",
            false,
        )
        .await;
    rt.cdp.init_world(&host).await;
    let pick = rt.cdp.pick(&host, 100., 140.).await;
    verdict(
        "csp_page_pick",
        !pick.is_null()
            && page["url"]
                .as_str()
                .is_some_and(|s| s.starts_with("https://github.com/")),
        json!({"page":page,"pick":pick}),
        results,
    );
}

async fn resize(h: Handle, rt: &Runtime, cx: &mut AsyncApp) -> bool {
    let (tx, rx) = async_channel::bounded(1);
    let start = std::time::Instant::now();
    // Await the actual frame with the new dimensions. A fixed sleep is not a
    // presentation event and can observe a valid, still-in-flight previous frame.
    rt.shared.borrow_mut().frame_waiter = Some((1504, 1408, tx));
    let _ = h.update(cx, |_, w, _| w.resize(size(px(1120.), px(760.))));
    let ok = futures_lite::future::or(async { rx.recv().await.is_ok() }, async {
        delay(cx, 3000).await;
        false
    })
    .await;
    let dims = rt
        .shared
        .borrow()
        .frame
        .as_ref()
        .map(|f| [f.get_width(), f.get_height()]);
    log(
        "resize_frame_complete",
        json!({"ok":ok,"elapsed_ms":start.elapsed().as_secs_f64()*1000.,"dimensions":dims}),
    );
    ok
}
