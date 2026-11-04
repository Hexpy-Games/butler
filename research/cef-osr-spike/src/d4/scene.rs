use crate::{input::Page, state::Runtime};
use gpui::accesskit::Live;
use gpui::{prelude::*, *};
use gpui_ce_elements::editable_text::{EditableTextState, StringStorage, text_area, text_input};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};

pub const ORDER: [&str; 8] = [
    "field_a",
    "field_b",
    "composer",
    "보내기",
    "첨부",
    "더보기",
    "열기",
    "page",
];
actions!(d4, [Accept, Next, Previous, Dismiss, Down, Up]);
pub struct Scene {
    pub fields: Vec<Entity<EditableTextState>>,
    pub page: Entity<Page>,
    pub field_b_bounds: Rc<RefCell<Bounds<Pixels>>>,
    pub buttons: Vec<(&'static str, FocusHandle)>,
    pub rows: Vec<String>,
    pub stream: String,
    pub submit_count_a: usize,
    pub menu: bool,
    pub dialog: bool,
}
impl Scene {
    pub fn new(rt: Runtime, w: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            fields: (0..3)
                .map(|_| cx.new(|cx| EditableTextState::new(StringStorage::default(), cx)))
                .collect(),
            page: cx.new(|cx| Page::new(rt, w, cx)),
            field_b_bounds: Rc::default(),
            buttons: [
                "보내기",
                "첨부",
                "더보기",
                "열기",
                "복사",
                "편집",
                "삭제",
                "취소",
                "확인",
            ]
            .into_iter()
            .map(|id| (id, cx.focus_handle()))
            .collect(),
            rows: ["첫 번째 메시지", "두 번째 메시지", "세 번째 메시지"]
                .map(String::from)
                .to_vec(),
            stream: String::new(),
            submit_count_a: 0,
            menu: false,
            dialog: false,
        }
    }
    pub fn focus(&self, id: &str, w: &mut Window, cx: &mut App) {
        let handle = match id {
            "field_a" => self.fields[0].read(cx).focus_handle(cx),
            "field_b" => self.fields[1].read(cx).focus_handle(cx),
            "composer" => self.fields[2].read(cx).focus_handle(cx),
            "page" => self.page.read(cx).focus.clone(),
            _ => self.buttons.iter().find(|b| b.0 == id).unwrap().1.clone(),
        };
        w.focus(&handle, cx);
    }
    pub fn focused(&self, w: &Window, cx: &App) -> String {
        for (i, id) in ["field_a", "field_b", "composer"].iter().enumerate() {
            if self.fields[i].read(cx).focus_handle(cx).is_focused(w) {
                return id.to_string();
            }
        }
        if self.page.read(cx).focus.is_focused(w) {
            return "page".into();
        }
        self.buttons
            .iter()
            .find(|b| b.1.is_focused(w))
            .map(|b| b.0.to_string())
            .unwrap_or_default()
    }
    pub fn clear(&mut self, index: usize, cx: &mut Context<Self>) {
        self.fields[index].update(cx, |s, cx| s.emplace("", cx));
        cx.notify();
    }
    fn send(&mut self, cx: &mut Context<Self>) {
        self.rows.push(self.fields[2].read(cx).as_str().to_string());
        self.clear(2, cx);
    }
    fn activate(&mut self, id: &str, w: &mut Window, cx: &mut Context<Self>) {
        match id {
            "field_a" => self.submit_count_a += 1,
            "composer" | "보내기" => self.send(cx),
            "더보기" => {
                self.menu = !self.menu;
                self.focus(if self.menu { "복사" } else { "더보기" }, w, cx);
            }
            "열기" => {
                self.dialog = true;
                self.focus("확인", w, cx);
            }
            "취소" | "확인" => {
                self.dialog = false;
                self.focus("열기", w, cx);
            }
            "복사" | "편집" | "삭제" => {
                self.menu = false;
                self.focus("더보기", w, cx);
            }
            _ => {}
        }
        cx.notify();
    }
    fn cycle(&self, delta: isize, w: &mut Window, cx: &mut Context<Self>) {
        let order: &[&str] = if self.dialog {
            &["취소", "확인"]
        } else if self.menu {
            &["복사", "편집", "삭제"]
        } else {
            &ORDER
        };
        let current = self.focused(w, cx);
        let i = order.iter().position(|id| *id == current).unwrap_or(0);
        self.focus(
            order[(i as isize + delta).rem_euclid(order.len() as isize) as usize],
            w,
            cx,
        );
    }
    fn dismiss(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.dialog {
            self.dialog = false;
            self.focus("열기", w, cx);
        } else if self.menu {
            self.menu = false;
            self.focus("더보기", w, cx);
        }
        cx.notify();
    }
    fn button(&self, id: &'static str, role: Role, cx: &Context<Self>) -> impl IntoElement {
        let handle = self.buttons.iter().find(|b| b.0 == id).unwrap().1.clone();
        div()
            .id(id)
            .role(role)
            .aria_label(id)
            .track_focus(&handle)
            .key_context("D4")
            .p_2()
            .border_1()
            .border_color(rgb(0x8090a0))
            .child(id)
            .on_click(cx.listener(move |s, _, w, cx| s.activate(id, w, cx)))
    }
    fn field(&self, index: usize, id: &'static str, label: &'static str) -> impl IntoElement {
        let input = if index == 2 {
            text_area(id)
        } else {
            text_input(id)
        };
        input
            .state(self.fields[index].downgrade())
            .aria_label(label)
            .role(if index == 2 {
                Role::MultilineTextInput
            } else {
                Role::TextInput
            })
            .w_full()
            .min_h(px(if index == 2 { 70. } else { 38. }))
            .p_2()
            .border_1()
            .border_color(rgb(0x8090a0))
    }
    fn panel(&self, cx: &Context<Self>) -> impl IntoElement {
        let bounds = self.field_b_bounds.clone();
        div()
            .w(px(450.))
            .flex()
            .flex_col()
            .gap_2()
            .child(self.field(0, "field_a", "제목"))
            .child(
                div()
                    .relative()
                    .child(self.field(1, "field_b", "검색"))
                    .child(
                        canvas(move |b, _, _| *bounds.borrow_mut() = b, |_, (), _, _| {})
                            .absolute()
                            .inset_0(),
                    ),
            )
            .child(self.field(2, "composer", "메시지 입력"))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(self.button("보내기", Role::Button, cx))
                    .child(self.button("첨부", Role::Button, cx))
                    .child(
                        div()
                            .id("설정")
                            .role(Role::Button)
                            .aria_label("설정")
                            .aria_disabled(true)
                            .p_2()
                            .child("설정"),
                    ),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(self.button("더보기", Role::Button, cx))
                    .child(self.button("열기", Role::Button, cx)),
            )
            .child(div().id("chat_list").role(Role::List).children(
                self.rows.iter().enumerate().map(|(i, row)| {
                    div()
                        .id(("row", i))
                        .role(Role::ListItem)
                        .aria_label(row.clone())
                        .child(row.clone())
                }),
            ))
            .child(
                div()
                    .id("stream")
                    .role(Role::Label)
                    .aria_label("응답")
                    .aria_value(self.stream.clone())
                    .aria_live(Live::Polite)
                    .child(self.stream.clone()),
            )
    }
    fn overlays(&self, cx: &Context<Self>) -> impl IntoElement {
        div()
            .id("overlays")
            .role(Role::Group)
            .when(self.menu, |d| {
                d.child(
                    div()
                        .id("menu")
                        .role(Role::Menu)
                        .absolute()
                        .left(px(350.))
                        .top(px(250.))
                        .bg(rgb(0x354555))
                        .p_2()
                        .children(
                            ["복사", "편집", "삭제"].map(|id| self.button(id, Role::MenuItem, cx)),
                        ),
                )
            })
            .when(self.dialog, |d| {
                d.child(
                    div()
                        .id("dialog")
                        .role(Role::Dialog)
                        .aria_modal(true)
                        .aria_label("확인 대화상자")
                        .absolute()
                        .left(px(250.))
                        .top(px(220.))
                        .bg(rgb(0x354555))
                        .p_4()
                        .child("변경 사항을 저장할까요?")
                        .child(self.button("취소", Role::Button, cx))
                        .child(self.button("확인", Role::Button, cx)),
                )
            })
    }
}
impl Render for Scene {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("main")
            .role(Role::Window)
            .key_context("D4")
            .size_full()
            .relative()
            .font_family("Arial")
            .text_size(px(18.))
            .bg(rgb(0x202c38))
            .text_color(rgb(0xffffff))
            .on_action(cx.listener(|s, _: &Accept, w, cx| s.activate(&s.focused(w, cx), w, cx)))
            .on_action(cx.listener(|s, _: &Next, w, cx| s.cycle(1, w, cx)))
            .on_action(cx.listener(|s, _: &Previous, w, cx| s.cycle(-1, w, cx)))
            .on_action(cx.listener(|s, _: &Down, w, cx| {
                if s.menu {
                    s.cycle(1, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &Up, w, cx| {
                if s.menu {
                    s.cycle(-1, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &Dismiss, w, cx| s.dismiss(w, cx)))
            .child(
                div()
                    .flex()
                    .size_full()
                    .gap_4()
                    .p_4()
                    .child(self.panel(cx))
                    .child(
                        div()
                            .id("page")
                            .role(Role::WebView)
                            .flex_1()
                            .h_full()
                            .child(self.page.clone()),
                    ),
            )
            .child(self.overlays(cx))
    }
}
pub struct Auxiliary(pub Entity<EditableTextState>);
impl Render for Auxiliary {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().p_4().child(
            text_input("field_c")
                .state(self.0.downgrade())
                .role(Role::TextInput)
                .aria_label("보조 입력")
                .w_full()
                .min_h(px(40.)),
        )
    }
}
pub fn field_snapshot(state: &Entity<EditableTextState>, w: &mut Window, cx: &mut App) -> Value {
    state.update(cx, |s, cx| {
        let marked = s.marked_text_range(w, cx);
        let selected = s.selected_text_range(false, w, cx).map(|s| s.range);
        let mut actual = None;
        let text = marked
            .clone()
            .and_then(|r| s.text_for_range(r, &mut actual, w, cx));
        json!({"text":s.as_str(), "marked_range":marked.map(|r| [r.start,r.end]),
            "selected_range":selected.map(|r| [r.start,r.end]), "marked_text":text})
    })
}
