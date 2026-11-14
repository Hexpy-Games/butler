//! Viewer copy and band fixtures of the browser showcases (BrowserPane `fixtures/copy.ts` and
//! `DemoBand.tsx`), as the app's containers pass them. Not part of `butler-ds`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::page_band::{PageBand, PageBandTone};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::thinking_mark::{ButlerThinkingMark, MarkState};
use gpui::{App, ElementId, IntoElement, ParentElement as _, Styled as _};

use crate::copy::Lang;

/// `BROWSER_DEMO_COPY`: the strings the band and address stories need.
pub(crate) struct BrowserCopy {
    pub url: &'static str,
    pub agent_using: &'static str,
    pub step: &'static str,
    pub take_over: &'static str,
    pub stop_task: &'static str,
    pub user_control: &'static str,
    pub butler_waits: &'static str,
    pub give_back: &'static str,
    pub waiting: &'static str,
    pub pay_step: &'static str,
    pub review: &'static str,
    pub need_you: &'static str,
    pub keypad: &'static str,
    pub pick_mode: &'static str,
    pub pick_hint: &'static str,
    pub drag_to_chat: &'static str,
    pub finish: &'static str,
    pub popup_blocked: &'static str,
    pub popup_host: &'static str,
    pub allow: &'static str,
    pub clear: &'static str,
}

pub(crate) fn copy(lang: Lang) -> BrowserCopy {
    lang.pick(
        BrowserCopy {
            url: "https://shop.example.com/search?q=office-chair",
            agent_using: "Butler is browsing",
            step: "Click ‘Mesh Office Chair M2’",
            take_over: "Take over",
            stop_task: "Stop task",
            user_control: "You're in control",
            butler_waits: "Butler is waiting",
            give_back: "Give back to Butler",
            waiting: "Waiting for approval",
            pay_step: "Pay ₩129,000",
            review: "Review",
            need_you: "Your input needed",
            keypad: "Security keypad · type it yourself",
            pick_mode: "Picking",
            pick_hint: "⇧ More · ⌥ Area",
            drag_to_chat: "drag into the chat",
            finish: "Done",
            popup_blocked: "Pop-up blocked",
            popup_host: "id.example.com",
            allow: "Allow",
            clear: "Clear",
        },
        BrowserCopy {
            url: "https://shop.example.com/search?q=office-chair",
            agent_using: "버틀러가 조작 중",
            step: "‘메쉬 사무용 의자 M2’ 클릭",
            take_over: "직접 조작",
            stop_task: "작업 중지",
            user_control: "직접 조작 중",
            butler_waits: "버틀러가 기다리는 중",
            give_back: "버틀러에게 돌려주기",
            waiting: "승인 대기",
            pay_step: "129,000원 결제",
            review: "승인 보기",
            need_you: "직접 입력 필요",
            keypad: "보안 키패드 · 직접 입력해 주세요",
            pick_mode: "요소 선택 중",
            pick_hint: "⇧ 여러 개 · ⌥ 영역",
            drag_to_chat: "끌어서 대화에 놓기",
            finish: "끝내기",
            popup_blocked: "팝업 차단됨",
            popup_host: "id.example.com",
            allow: "허용",
            clear: "선택 해제",
        },
    )
}

/// `DemoBandKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BandKind {
    Agent,
    User,
    Waiting,
    NeedYou,
    Pick,
    Popup,
    AgentPopup,
}

fn glyph(which: Icon, size: IconSize, cx: &App) -> impl IntoElement + use<> {
    icon(which, size, Ds::get(cx))
}

fn button(id: &'static str, text: &'static str, variant: Variant, id_base: &ElementId) -> Button {
    Button::new((id_base.clone(), id))
        .size(Size::Xs)
        .variant(variant)
        .text(text)
}

/// The blocked pop-up band: Allow, and a clear button.
fn popup_band(id: &ElementId, c: &BrowserCopy, cx: &App) -> PageBand {
    PageBand::new(id.clone(), PageBandTone::Info, c.popup_blocked)
        .icon(glyph(Icon::Popup, IconSize::Md, cx))
        .detail(c.popup_host)
        .actions(
            gpui::div()
                .flex()
                .items_center()
                .gap(Ds::get(cx).len(butler_ds::tokens::Length::SpaceXs))
                .child(button::container(Size::Xs).child(button(
                    "allow",
                    c.allow,
                    Variant::Outline,
                    id,
                )))
                .child(IconButton::new((id.clone(), "clear"), c.clear).glyph(Icon::X)),
        )
}

/// The page band for each state, as the app's band container composes it.
pub(crate) fn demo_band(
    id: impl Into<ElementId>,
    kind: BandKind,
    lang: Lang,
    cx: &App,
) -> PageBand {
    let id = id.into();
    let c = copy(lang);
    let stop = |id: &ElementId| {
        button("stop", c.stop_task, Variant::Outline, id).icon_start(glyph(
            Icon::Square,
            IconSize::Sm,
            cx,
        ))
    };
    let mark = |working: bool| {
        let mark = ButlerThinkingMark::new((id.clone(), "mark")).size(IconSize::Sm);
        if working {
            mark.state(MarkState::Working)
        } else {
            mark
        }
    };
    let pair =
        |first: Button, id: &ElementId| button::container(Size::Xs).child(first).child(stop(id));
    match kind {
        BandKind::Agent | BandKind::AgentPopup => {
            let detail = if kind == BandKind::Agent {
                c.step
            } else {
                c.popup_blocked
            };
            PageBand::new(id.clone(), PageBandTone::Agent, c.agent_using)
                .icon(mark(true))
                .detail(detail)
                .actions(pair(
                    button("take", c.take_over, Variant::Outline, &id),
                    &id,
                ))
        }
        BandKind::User => PageBand::new(id.clone(), PageBandTone::User, c.user_control)
            .icon(mark(false))
            .detail(c.butler_waits)
            .actions(pair(
                button("back", c.give_back, Variant::Default, &id),
                &id,
            )),
        BandKind::Waiting => PageBand::new(id.clone(), PageBandTone::Waiting, c.waiting)
            .icon(glyph(Icon::ShieldQuestion, IconSize::Md, cx))
            .detail(c.pay_step)
            .actions(pair(button("review", c.review, Variant::Outline, &id), &id)),
        BandKind::NeedYou => PageBand::new(id.clone(), PageBandTone::Warning, c.need_you)
            .icon(glyph(Icon::Key, IconSize::Md, cx))
            .detail(c.keypad)
            .actions(pair(
                button("take", c.take_over, Variant::Default, &id),
                &id,
            )),
        BandKind::Pick => PageBand::new(id.clone(), PageBandTone::Pick, c.pick_mode)
            .icon(glyph(Icon::Pick, IconSize::Md, cx))
            .detail(c.drag_to_chat)
            .hint(c.pick_hint)
            .actions(button::container(Size::Xs).child(button(
                "finish",
                c.finish,
                Variant::Outline,
                &id,
            ))),
        BandKind::Popup => popup_band(&id, &c, cx),
    }
}
