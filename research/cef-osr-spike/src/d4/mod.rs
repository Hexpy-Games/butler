pub mod ax;
mod inject;
mod scene;
mod script;
use crate::{cdp, cef_gate, pump, state};
use cef::ImplBrowserHost;
use gpui::*;
use std::{cell::RefCell, path::PathBuf, rc::Rc, time::Duration};

pub fn start(args: cef::args::Args, cx: &mut App, out: PathBuf) {
    std::fs::create_dir_all(&out).expect("D4 output directory");
    std::fs::write(out.join("pid"), std::process::id().to_string()).expect("D4 PID");
    let baseline = ax::foreign_windows();
    let (pump_tx, pump_rx) = async_channel::unbounded();
    let (tx, rx) = async_channel::bounded(1);
    let (start, _) = async_channel::bounded(1);
    let rt = state::Runtime {
        shared: Rc::new(RefCell::new(state::Shared {
            scale: 2.,
            ..Default::default()
        })),
        browser: Rc::default(),
        cdp: cdp::Cdp::new(cx),
        start,
    };
    bindings(cx);
    let r = rt.clone();
    let window = cx
        .open_window(options("main", 40., 40., 1100., 760.), move |w, cx| {
            w.set_a11y_forced(true);
            cx.new(|cx| scene::Scene::new(r, w, cx))
        })
        .expect("main D4 window");
    cx.activate(true);
    crate::unsafe_boundary::observe_visibility(pump_tx.clone());
    pump::run(pump_rx, rt.clone(), cx);
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(Duration::from_millis(500))
            .await;
        crate::initialize(&args, cef_gate::Pump::new(pump_tx), rt.clone(), tx);
        let host = rt.host().expect("D4 CEF host");
        host.set_accessibility_state(cef::State::ENABLED);
        let mut observer = rt.cdp.observer();
        let _registration = host.add_dev_tools_message_observer(Some(&mut observer));
        let refresh = rt.clone();
        cx.spawn(async move |cx| {
            while rx.recv().await.is_ok() {
                if refresh.shared.borrow().closed {
                    break;
                }
                let _ = window.update(cx, |_, w, _| w.refresh());
            }
        })
        .detach();
        cx.background_executor().timer(Duration::from_secs(2)).await;
        rt.cdp.eval(&host, r#"(async () => { await new Promise(resolve => document.readyState === 'complete' ? resolve() : addEventListener('load', resolve, {once:true})); document.querySelector('h1').textContent = '웹 제목'; document.querySelector('#text').insertAdjacentHTML('beforebegin', '<button>웹 버튼</button><input id="web_in" aria-label="웹 입력">'); return true; })()"#, false).await;
        if let Err(error) = script::run(window, rt.clone(), out.clone(), baseline, cx).await {
            let _ = std::fs::write(out.join("setup-error.txt"), error);
            rt.close();
            std::process::exit(1);
        }
        rt.close();
        cx.background_executor()
            .timer(Duration::from_millis(500))
            .await;
        rt.browser.borrow_mut().take();
        drop(_registration);
        cef::shutdown();
        crate::CEF_STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
        cx.update(|cx| cx.quit());
    })
    .detach();
}
pub fn options(title: &str, x: f32, y: f32, width: f32, height: f32) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(x), px(y)),
            size(px(width), px(height)),
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some(title.to_owned().into()),
            ..Default::default()
        }),
        ..Default::default()
    }
}
fn bindings(cx: &mut App) {
    use gpui_ce_elements::editable_text::actions::{self, DEFAULT_INPUT_CONTEXT, default_bindings};
    cx.bind_keys(default_bindings().as_keybindings(Some(DEFAULT_INPUT_CONTEXT)));
    for context in ["D4", DEFAULT_INPUT_CONTEXT] {
        cx.bind_keys([
            KeyBinding::new("enter", scene::Accept, Some(context)),
            KeyBinding::new("tab", scene::Tab, Some(context)),
            KeyBinding::new("shift-tab", scene::BackTab, Some(context)),
            KeyBinding::new("escape", scene::Dismiss, Some(context)),
        ]);
    }
    cx.bind_keys([
        KeyBinding::new("shift-enter", actions::Enter, Some(DEFAULT_INPUT_CONTEXT)),
        KeyBinding::new("down", scene::Down, Some("D4")),
        KeyBinding::new("up", scene::Up, Some("D4")),
    ]);
}
