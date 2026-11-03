use crate::{field::Field, input::Page, log, state::Runtime};
use cef::ImplRunContextMenuCallback;
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};
#[derive(Clone)]
pub struct Picked(pub Value);
impl Render for Picked {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(290.))
            .p_3()
            .bg(rgb(0xb52178))
            .text_color(rgb(0xffffff))
            .text_size(px(16.))
            .child(format!(
                "{}: {}",
                self.0["tag"].as_str().unwrap_or("?"),
                self.0["title"].as_str().unwrap_or("")
            ))
    }
}
pub struct Spike {
    pub rt: Runtime,
    pub page: Entity<Page>,
    pub field: Entity<Field>,
    pub popover: bool,
    pub chips: Rc<RefCell<Vec<Value>>>,
    pub target: Rc<RefCell<Bounds<Pixels>>>,
}
impl Spike {
    pub fn new(rt: Runtime, w: &mut Window, cx: &mut Context<Self>) -> Self {
        let page = cx.new(|cx| Page::new(rt.clone(), w, cx));
        let field = cx.new(Field::new);
        Self {
            rt,
            page,
            field,
            popover: false,
            chips: Rc::default(),
            target: Rc::default(),
        }
    }
    fn composer(&self) -> impl IntoElement {
        let chips = self.chips.clone();
        let target = self.target.clone();
        let rt = self.rt.clone();
        div().w(px(368.)).h_full().p_4().flex().flex_col().gap_3().bg(rgba(0x20304099))
            .child("Composer").child("CEF OSR fixture").child("Aa 한글 123 • GPUI 20px")
            .child(div().id("drop").relative().w_full().h(px(150.)).border_2().border_color(rgb(0x70b0e0)).p_3().child("Drop here")
                .on_drop(move |p:&Picked,_,cx|{
                    chips.borrow_mut().push(p.0.clone());let index=chips.borrow().len()-1;log("gpui_drop",json!({"count":index+1,"chip":p.0}));
                    let chips=chips.clone();let rt=rt.clone();let rect=p.0["cropRect"].clone();
                    cx.spawn(async move |cx|{
                        use base64::Engine;
                        if let Some(h)=rt.host(){
                            let mut clip=rect;clip["scale"]=json!(1);
                            let result=rt.cdp.call(&h,"Page.captureScreenshot",json!({"format":"png","fromSurface":true,"clip":clip,"captureBeyondViewport":false})).await;
                            if let Some(b64)=result["value"]["data"].as_str()&& let Ok(bytes)=base64::engine::general_purpose::STANDARD.decode(b64){
                                let path=format!("{}/shots/chip-crop-{index}.png",crate::ROOT);std::fs::write(&path,bytes).unwrap();chips.borrow_mut()[index]["cropPath"]=json!(path);log("chip_crop",json!({"path":path}));
                            }
                        }
                        cx.update(|cx|cx.refresh_windows());
                    }).detach();
                })
                .on_drag_over::<Picked>(|style,_,_,_|style.bg(rgb(0x298355)))
                .child(canvas(move |b,_,_|*target.borrow_mut()=b,|_,(),_,_|{}).absolute().inset_0()))
            .child(self.field.clone())
            .children(self.chips.borrow().iter().map(|p|div().w_full().p_2().bg(rgb(0x304060)).flex().flex_col().gap_2()
                .child(format!("{}: {}",p["tag"].as_str().unwrap_or("?"),p["title"].as_str().unwrap_or("")))
                .child(div().text_size(px(12.)).child(format!("({}, {}) {} × {}",p["rect"]["x"],p["rect"]["y"],p["rect"]["width"],p["rect"]["height"])))
                .when_some(p["cropPath"].as_str(),|d,path|d.child(img(std::path::PathBuf::from(path)).w_full().max_h(px(120.)).object_fit(ObjectFit::Contain)))
            ).collect::<Vec<_>>())
    }
}
impl Render for Spike {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let picking = self.page.read(cx).picking;
        let context = self.rt.shared.borrow().context.clone();
        let origin = self.rt.shared.borrow().bounds.origin;
        let shared = self.rt.shared.clone();
        div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .font_family("Arial")
            .text_size(px(20.))
            .text_color(rgb(0xffffff))
            .child(
                div()
                    .h(px(56.))
                    .flex_shrink_0()
                    .p_3()
                    .flex()
                    .gap_4()
                    .bg(rgba(0x203040bb))
                    .when(self.rt.host().is_none(), |d| {
                        let start = self.rt.start.clone();
                        d.child(
                            div()
                                .id("show")
                                .child("Show page")
                                .on_click(move |_, _, _| {
                                    let _ = start.try_send(());
                                }),
                        )
                    })
                    .child(
                        div()
                            .id("pick")
                            .cursor_pointer()
                            .child(if picking { "Pick: On" } else { "Pick: Off" })
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.page.update(cx, |p, cx| {
                                    p.picking = !p.picking;
                                    cx.notify();
                                });
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("popover")
                            .cursor_pointer()
                            .child("Popover")
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.popover = !s.popover;
                                log("popover", json!(s.popover));
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h(px(0.))
                    .child(
                        div()
                            .flex_1()
                            .h_full()
                            .min_w(px(0.))
                            .child(self.page.clone()),
                    )
                    .child(self.composer()),
            )
            .when(self.popover, |d| {
                d.child(
                    div()
                        .absolute()
                        .left(px(70.))
                        .top(px(100.))
                        .w(px(300.))
                        .h(px(160.))
                        .bg(rgb(0x982080))
                        .p_4()
                        .child("GPUI POPOVER ABOVE PAGE"),
                )
            })
            .when_some(context, |d, (x, y, items, callback)| {
                d.child(
                    div()
                        .absolute()
                        .left(origin.x + px(x as f32))
                        .top(origin.y + px(y as f32))
                        .w(px(230.))
                        .bg(rgb(0x283648))
                        .border_1()
                        .border_color(rgb(0x85aacc))
                        .p_2()
                        .children(items.into_iter().map(move |(id, label)| {
                            let cb = callback.clone();
                            let shared = shared.clone();
                            div().id(("menu", id as u64)).p_2().child(label).on_click(
                                move |_, w, _| {
                                    cb.cont(id, cef::EventFlags::default());
                                    shared.borrow_mut().context = None;
                                    w.refresh();
                                },
                            )
                        })),
                )
            })
    }
}
