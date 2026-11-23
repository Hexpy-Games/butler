//! The tab's one band (Electron `AgentControl` and `browserPopupNotice`): who holds a page the
//! Agent hosts, else a blocked or open pop-up; none while Butler does nothing on the tab. A
//! pop-up joins the holder band as its detail and first action.
use super::{
    agent_host::{Holder, Hosted, ShownHolder, shown_holder},
    model::{BrowserState, Owner, Tab},
};
use crate::ui::{
    decisions::stop_conversation,
    i18n::{browser::BrowserStrings, browser_handoff::BrowserHandoff},
    widgets::{anchor, anchored},
};
use butler_ds::ui::{
    Icon,
    blocks::page_band::{PageBand, PageBandTone},
    button::{self, Button, Size, Variant},
    context::Ds,
    icon::{IconSize, icon},
    thinking_mark::{ButlerThinkingMark, MarkState},
};
use gpui::{AnyElement, App, SharedString, div, prelude::*};

/// A blocked or open pop-up: what happened, the pop-up's host and what you can do.
struct Notice {
    label: &'static str,
    detail: Option<String>,
    action: Option<AnyElement>,
}

impl Notice {
    /// The notice as one line, for the detail of the holder band.
    fn text(&self) -> String {
        match &self.detail {
            Some(detail) => format!("{} · {detail}", self.label),
            None => self.label.to_owned(),
        }
    }
}

/// The band of `tab`.
pub(super) fn band(tab: &Tab, cx: &App) -> Option<PageBand> {
    let id = SharedString::from(format!("browser-band-{}", tab.id.0));
    let notice = popup_notice(tab, cx);
    if tab.picking {
        return Some(pick_band(id, tab, notice, cx));
    }
    match tab.hosted.as_ref() {
        Some(hosted) if shown_holder(tab) != ShownHolder::None => {
            Some(holder_band(id, tab, hosted, notice, cx))
        }
        _ => notice.map(|notice| {
            let mut band = PageBand::new(id, PageBandTone::Info, notice.label).icon(popup_icon(cx));
            if let Some(detail) = notice.detail {
                band = band.detail(detail);
            }
            if let Some(action) = notice.action {
                band = band.actions(button::container(Size::Xs).child(action));
            }
            band
        }),
    }
}

fn pick_band(id: SharedString, tab: &Tab, notice: Option<Notice>, cx: &App) -> PageBand {
    let w = super::pick::words(cx);
    let text = notice.as_ref().map(Notice::text);
    let tab_id = tab.id.clone();
    PageBand::new(id, PageBandTone::Pick, w.mode)
        .icon(
            anchor(div(), "browser-pick-band")
                .child(icon(Icon::Pick, IconSize::Sm, Ds::get(cx)))
                .into_any_element(),
        )
        .detail(text.clone().unwrap_or_else(|| w.drag.to_owned()))
        .hint(if text.is_some() { w.drag } else { w.keys })
        .actions(
            button::container(Size::Xs)
                .children(notice.and_then(|n| n.action))
                .child(anchored(
                    Button::new("browser-pick-done")
                        .size(Size::Xs)
                        .variant(Variant::Outline)
                        .text(w.finish)
                        .on_click(move |_, _, cx| super::pick::mode(&tab_id, false, cx)),
                    "browser-pick-done",
                )),
        )
}

fn holder_band(
    id: SharedString,
    tab: &Tab,
    hosted: &Hosted,
    notice: Option<Notice>,
    cx: &App,
) -> PageBand {
    let c = BrowserStrings::get(cx);
    let handoff = BrowserHandoff::get(cx);
    let human = hosted.holder == Holder::User;
    let tone = if hosted.waiting {
        PageBandTone::Waiting
    } else if human {
        PageBandTone::User
    } else {
        PageBandTone::Agent
    };
    let mark = ButlerThinkingMark::new(SharedString::from(format!("{id}-mark")))
        .state(if human || hosted.waiting {
            MarkState::Idle
        } else {
            MarkState::Working
        })
        .size(IconSize::Sm);
    let label = if hosted.signin_step().is_some() {
        handoff.sign_in_title
    } else if hosted.pay_step().is_some() {
        handoff.pay_title
    } else if hosted.waiting && human && tab.dialog.is_none() {
        c.butler_waits
    } else if hosted.waiting {
        c.waiting
    } else if human {
        c.user_control
    } else {
        c.agent_using
    };
    let lang = Ds::get(cx).lang();
    let detail = (notice.as_ref().map(Notice::text))
        .or_else(|| {
            hosted
                .signin_step()
                .map(|step| sign_in_step(step, cx).to_owned())
        })
        .or_else(|| {
            (hosted.pay_step()).map(|step| BrowserHandoff::pay_step(lang, step).to_owned())
        });
    let mark = anchor(div(), "browser-band").child(mark).into_any_element();
    let mut band = PageBand::new(id, tone, label).icon(mark);
    if let Some(detail) = detail {
        band = band.detail(detail);
    }
    if human && !hosted.sticky {
        band = band.hint(c.auto_give_back);
    }
    band.actions(holder_actions(
        tab,
        hosted,
        notice.and_then(|n| n.action),
        cx,
    ))
}

/// Electron `signinStepLabel`.
fn sign_in_step(step: &str, cx: &App) -> &'static str {
    let c = BrowserStrings::get(cx);
    match step {
        "mfa" | "passkey" | "secure_keypad" => {
            BrowserHandoff::sign_in_step(Ds::get(cx).lang(), step)
        }
        "captcha" => c.captcha,
        _ => c.signin_form,
    }
}

/// The pop-up's action, then Take over or Give back, then Stop task (Electron's order).
fn holder_actions(
    tab: &Tab,
    hosted: &Hosted,
    popup: Option<AnyElement>,
    cx: &App,
) -> impl IntoElement {
    let c = BrowserStrings::get(cx);
    let human = hosted.holder == Holder::User;
    let id = tab.id.clone();
    let toggle = Button::new("browser-control")
        .size(Size::Xs)
        .variant(if hosted.in_use() || hosted.waiting {
            Variant::Default
        } else {
            Variant::Outline
        })
        .text(if human { c.give_back } else { c.take_over })
        .on_click(move |_, _, cx| {
            let (holder, sticky) = if human {
                (Holder::Agent, false)
            } else {
                (Holder::User, true)
            };
            cx.global_mut::<BrowserState>().control(&id, holder, sticky);
            cx.refresh_windows();
        });
    let owner = tab.owner.clone();
    let stop = Button::new("browser-stop-task")
        .size(Size::Xs)
        .variant(Variant::Outline)
        .icon_start(icon(Icon::Square, IconSize::Sm, Ds::get(cx)))
        .text(BrowserHandoff::get(cx).stop)
        .on_click(move |_, _, cx| {
            if let Owner::Conversation(session) = &owner {
                stop_conversation(session, cx);
            }
        });
    button::container(Size::Xs)
        .children(popup)
        .child(anchored(toggle, "browser-control"))
        .child(anchored(stop, "browser-stop-task"))
}

/// Electron `popupNotice`: a blocked pop-up, else the pop-up this tab opened.
fn popup_notice(tab: &Tab, cx: &App) -> Option<Notice> {
    let c = BrowserStrings::get(cx);
    let id = tab.id.clone();
    if let Some(blocked) = &tab.blocked_popup {
        let action = (blocked.reason == "no_gesture").then(|| {
            anchored(
                Button::new("browser-popup-allow")
                    .size(Size::Xs)
                    .variant(Variant::Ghost)
                    .text(c.allow)
                    .on_click(move |_, _, cx| {
                        cx.global_mut::<BrowserState>().allow_popup(&id);
                        cx.refresh_windows();
                    }),
                "browser-popup-allow",
            )
        });
        return Some(Notice {
            label: c.popup_blocked,
            detail: None,
            action,
        });
    }
    let popup = cx
        .global::<BrowserState>()
        .tabs()
        .iter()
        .find(|t| t.opener.as_ref() == Some(&tab.id))?;
    let host = url::Url::parse(&popup.url)
        .ok()
        .map(|u| u[url::Position::BeforeHost..url::Position::AfterPort].to_owned())
        .unwrap_or_default();
    let child = popup.id.clone();
    Some(Notice {
        label: c.popup_opened,
        detail: (!host.is_empty()).then_some(host),
        action: Some(anchored(
            Button::new("browser-popup-show")
                .size(Size::Xs)
                .variant(Variant::Ghost)
                .text(c.show_popup)
                .on_click(move |_, _, cx| super::popup_window::focus(&child, cx)),
            "browser-popup-show",
        )),
    })
}

fn popup_icon(cx: &App) -> AnyElement {
    anchor(div(), "browser-band")
        .child(icon(Icon::Popup, IconSize::Sm, Ds::get(cx)))
        .into_any_element()
}
