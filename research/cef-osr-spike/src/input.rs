use crate::{log, state::Runtime};
use cef::{ImplBrowser, ImplBrowserHost, ImplFrame};
use gpui::{prelude::*, *};
use serde_json::json;
use std::ops::Range;
pub struct Page {
    pub rt: Runtime,
    pub focus: FocusHandle,
    pub picking: bool,
    pub picked: serde_json::Value,
    pub marked: Option<Range<usize>>,
    pub text: String,
    pub selection: Range<usize>,
    pub pick_busy: bool,
}
impl Page {
    pub fn new(rt: Runtime, w: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        let r = rt.clone();
        cx.on_blur(&focus, w, move |_, _, _| {
            if let Some(h) = r.host() {
                h.set_focus(0);
            }
            log("page_focus", json!(false));
        })
        .detach();
        let r = rt.clone();
        cx.on_focus(&focus, w, move |_, _, _| {
            if let Some(h) = r.host() {
                h.set_focus(1);
            }
            log("page_focus", json!(true));
        })
        .detach();
        Self {
            rt,
            focus,
            picking: false,
            picked: serde_json::Value::Null,
            marked: None,
            text: String::new(),
            selection: 0..0,
            pick_busy: false,
        }
    }
    pub fn pick(&mut self, p: Point<Pixels>, cx: &mut Context<Self>) {
        if self.pick_busy {
            return;
        }
        self.pick_busy = true;
        let b = self.rt.shared.borrow().bounds;
        let (x, y) = (f32::from(p.x - b.origin.x), f32::from(p.y - b.origin.y));
        let rt = self.rt.clone();
        cx.spawn(async move |entity, cx| {
            let picked = if let Some(host) = rt.host() {
                rt.cdp.pick(&host, x, y).await
            } else {
                serde_json::Value::Null
            };
            let _ = entity.update(cx, |s, cx| {
                s.picked = picked;
                s.pick_busy = false;
                log("pick_result", s.picked.clone());
                cx.notify();
            });
        })
        .detach();
    }
    fn mouse(
        &self,
        p: Point<Pixels>,
        m: Modifiers,
        pressed: Option<MouseButton>,
    ) -> cef::MouseEvent {
        let b = self.rt.shared.borrow().bounds;
        cef::MouseEvent {
            x: f32::from(p.x - b.origin.x) as i32,
            y: f32::from(p.y - b.origin.y) as i32,
            modifiers: flags(m, pressed),
        }
    }
    fn down(&mut self, e: &MouseDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        w.focus(&self.focus, cx);
        if self.picking {
            self.pick(e.position, cx);
            return;
        }
        if let Some(h) = self.rt.host() {
            self.rt.input();
            h.send_mouse_click_event(
                Some(&self.mouse(e.position, e.modifiers, Some(e.button))),
                button(e.button),
                0,
                e.click_count as i32,
            );
        }
    }
    fn up(&mut self, e: &MouseUpEvent, _w: &mut Window, _cx: &mut Context<Self>) {
        if self.picking {
            return;
        }
        if let Some(h) = self.rt.host() {
            h.send_mouse_click_event(
                Some(&self.mouse(e.position, e.modifiers, None)),
                button(e.button),
                1,
                e.click_count as i32,
            );
        }
    }
    fn key(&mut self, k: &Keystroke, up: bool) {
        if self.picking {
            return;
        }
        let Some(h) = self.rt.host() else {
            return;
        };
        self.rt.input();
        // Cocoa editing commands must accompany raw command shortcuts in OSR.
        if k.modifiers.platform
            && !up
            && let Some(f) = self
                .rt
                .browser
                .borrow()
                .as_ref()
                .and_then(|b| b.focused_frame())
        {
            match k.key.as_str() {
                "a" => f.select_all(),
                "c" => f.copy(),
                "v" => f.paste(),
                "x" => f.cut(),
                "z" => f.undo(),
                _ => {}
            }
        }
        let (vk, native) = key_codes(&k.key);
        h.send_key_event(Some(&cef::KeyEvent {
            type_: if up {
                cef::KeyEventType::KEYUP
            } else {
                cef::KeyEventType::RAWKEYDOWN
            },
            modifiers: flags(k.modifiers, None),
            windows_key_code: vk,
            native_key_code: native,
            ..Default::default()
        }));
        // Printable text is committed by EntityInputHandler, preserving macOS IME.
    }
}
impl Render for Page {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let leave = cx.entity();
        let entity = cx.entity();
        let rt = self.rt.clone();
        let focus = self.focus.clone();
        let paint_rt = rt.clone();
        let picked = self.picked.clone();
        let picking = self.picking;
        let drag = crate::ui::Picked(picked.clone());
        div().id("page").relative().size_full().track_focus(&self.focus)
            .cursor(if picking{CursorStyle::Crosshair}else{self.rt.shared.borrow().cursor})
            .on_mouse_down(MouseButton::Left,cx.listener(Self::down))
            .on_mouse_down(MouseButton::Right,cx.listener(Self::down))
            .on_mouse_up(MouseButton::Left,cx.listener(Self::up))
            .on_mouse_up(MouseButton::Right,cx.listener(Self::up))
            .on_mouse_move(cx.listener(|s,e:&MouseMoveEvent,_,cx|{
                if s.picking {s.pick(e.position,cx);}else if let Some(h)=s.rt.host(){h.send_mouse_move_event(Some(&s.mouse(e.position,e.modifiers,e.pressed_button)),0);}
            }))
            .on_mouse_up_out(MouseButton::Left,cx.listener(Self::up))
            .on_mouse_move_all(move |e:&MouseMoveEvent,phase,_,_,cx|{if phase.bubble(){leave.update(cx,|s,_|{if !s.picking && !s.rt.shared.borrow().bounds.contains(&e.position)&& let Some(h)=s.rt.host(){h.send_mouse_move_event(Some(&s.mouse(e.position,e.modifiers,e.pressed_button)),1);}});}})
            .on_mouse_exit(cx.listener(|s,e:&MouseExitEvent,_,_|{if !s.picking&& let Some(h)=s.rt.host(){h.send_mouse_move_event(Some(&s.mouse(e.position,e.modifiers,e.pressed_button)),1);}}))
            .on_scroll_wheel(cx.listener(|s,e:&ScrollWheelEvent,_,_|{
                if !s.picking&& let Some(h)=s.rt.host(){s.rt.input();let d=e.delta.pixel_delta(px(20.));h.send_mouse_wheel_event(Some(&s.mouse(e.position,e.modifiers,None)),f32::from(d.x) as i32,f32::from(d.y) as i32);}
            }))
            .on_key_down(cx.listener(|s,e:&KeyDownEvent,_,_|s.key(&e.keystroke,false)))
            .on_key_up(cx.listener(|s,e:&KeyUpEvent,_,_|s.key(&e.keystroke,true)))
            .when(picking&&!picked.is_null(),|d|d.on_drag(drag,|data,_,_,cx|{log("gpui_drag_start",data.0.clone());cx.new(|_|data.clone())}))
            .child(canvas(move |b,w,_|{
                let mut s=rt.shared.borrow_mut();let changed=s.bounds!=b || s.scale!=w.scale_factor();s.bounds=b;s.scale=w.scale_factor();drop(s);
                if changed {if let Some(h)=rt.host(){h.notify_screen_info_changed();h.was_resized();rt.shared.borrow().want_frame();}log("page_layout",json!({"x":f32::from(b.origin.x),"y":f32::from(b.origin.y),"w":f32::from(b.size.width),"h":f32::from(b.size.height),"scale":w.scale_factor()}));}b
            },move |_,b,w,cx|{
                w.handle_input(&focus,ElementInputHandler::new(b,entity.clone()),cx);
                let s=paint_rt.shared.borrow();
                w.with_content_mask(Some(ContentMask{bounds:b,..Default::default()}),|w|{
                    if let Some(f)=&s.frame{crate::presentation::encoded(f);w.paint_surface(b,SurfaceSource::Surface(f.clone()));}
                    if s.popup_show&& let Some(f)=&s.popup{let r=&s.popup_rect;w.paint_surface(Bounds::new(b.origin+point(px(r.x as f32),px(r.y as f32)),size(px(r.width as f32),px(r.height as f32))),SurfaceSource::Surface(f.clone()));}
                });
                if picking&&!picked.is_null(){let r=&picked["rect"];let n=|k:&str|r[k].as_f64().unwrap_or(0.) as f32;
                    w.paint_quad(PaintQuad::new(Bounds::new(b.origin+point(px(n("x")),px(n("y"))),size(px(n("width")),px(n("height"))))).background(rgba(0x40aaff22)).border_widths(px(2.)).border_color(rgb(0x00aaff)));
                }
            }).size_full())
    }
}
fn button(b: MouseButton) -> cef::MouseButtonType {
    match b {
        MouseButton::Right => cef::MouseButtonType::RIGHT,
        MouseButton::Middle => cef::MouseButtonType::MIDDLE,
        _ => cef::MouseButtonType::LEFT,
    }
}
fn flags(m: Modifiers, b: Option<MouseButton>) -> u32 {
    (u32::from(m.shift) * 2)
        | (u32::from(m.control) * 4)
        | (u32::from(m.alt) * 8)
        | (u32::from(m.platform) * 128)
        | match b {
            Some(MouseButton::Left) => 16,
            Some(MouseButton::Middle) => 32,
            Some(MouseButton::Right) => 64,
            _ => 0,
        }
}
fn key_codes(k: &str) -> (i32, i32) {
    match k {
        "left" => (37, 123),
        "right" => (39, 124),
        "up" => (38, 126),
        "down" => (40, 125),
        "backspace" => (8, 51),
        "delete" => (46, 117),
        "enter" => (13, 36),
        "tab" => (9, 48),
        "escape" => (27, 53),
        "home" => (36, 115),
        "end" => (35, 119),
        "a" => (65, 0),
        "c" => (67, 8),
        "v" => (86, 9),
        "x" => (88, 7),
        "z" => (90, 6),
        _ => (
            k.to_uppercase()
                .chars()
                .next()
                .map(|v| v as i32)
                .unwrap_or(0),
            0,
        ),
    }
}
