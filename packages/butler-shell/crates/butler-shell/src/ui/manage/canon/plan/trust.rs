//! `CanonTrustDialog.tsx` and `canonTrust.ts`: a connected tool asks for canon access; the
//! owner allows or denies it, one request at a time.
use butler_ds::ui::blocks::key_value_row::{Detail, KeyValueRow};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Layout,
    MaxHeight,
};
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{Context, Entity, IntoElement, ParentElement as _, Render, Window};
use serde::Deserialize;
use serde_json::{Value, json};

use super::copy::words;
use crate::ui::manage::canon::common::person_name;
use crate::ui::manage::{ManageLive, Topic};
use crate::ui::source::fetch::{fetch, fetch_if};

/// `CanonGrant`
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct Grant {
    id: String,
    client_title: String,
    requested_at: i64,
    state: String,
    #[serde(default)]
    requested: Vec<String>,
}

#[derive(Deserialize)]
struct Grants {
    grants: Vec<Grant>,
}

#[derive(Clone, Copy)]
enum Decision {
    Allow,
    Deny,
}

/// `CanonTrustDialog`: reads the pending grants when `Topic::CanonTrust` moves: the shell
/// connecting to the agent, `canon.trust_requested`, `canon.trust_changed`,
/// `stream.reconcile_required`. It is built with the window, before any agent is attached, so
/// it has nothing to read until the first connect (React's request waits for the agent).
pub(crate) struct CanonTrustDialog {
    grants: Vec<Grant>,
    busy: bool,
    seen: u64,
}

impl CanonTrustDialog {
    pub(crate) fn new(live: &Entity<ManageLive>, cx: &mut Context<Self>) -> Self {
        let seen = live.read(cx).revision(&Topic::CanonTrust);
        cx.observe(live, |this, live, cx| {
            let revision = live.read(cx).revision(&Topic::CanonTrust);
            if revision != this.seen {
                this.seen = revision;
                Self::refresh(cx);
            }
        })
        .detach();
        Self {
            grants: Vec::new(),
            busy: false,
            seen,
        }
    }

    /// `useCanonGrants(true).refresh`: the pending grants, oldest first (revoked ones left out).
    fn refresh(cx: &mut Context<Self>) {
        fetch_if(
            cx,
            |client| async move { client.get_canon_grants(Some("pending")).await },
            |this: &mut Self, result: Result<Grants, Error>, cx| match result {
                Ok(Grants { mut grants }) => {
                    grants.retain(|grant| grant.state != "revoked");
                    grants.sort_by(|a, b| {
                        a.requested_at
                            .cmp(&b.requested_at)
                            .then_with(|| a.id.cmp(&b.id))
                    });
                    std::mem::replace(&mut this.grants, grants) != this.grants
                }
                Err(_) => {
                    let copy = words(Ds::get(cx).lang());
                    toast::show(cx, Toast::error(copy.request_failed));
                    false
                }
            },
        );
    }

    fn decide(&mut self, decision: Decision, cx: &mut Context<Self>) {
        let Some(grant) = self.grants.first() else {
            return;
        };
        if self.busy {
            return;
        }
        let id = grant.id.clone();
        self.busy = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move {
                match decision {
                    Decision::Allow => client.allow_canon_grant(&id, &json!({})).await,
                    Decision::Deny => client.deny_canon_grant(&id, &json!({})).await,
                }
            },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(_) => Self::refresh(cx),
                    Err(_) => {
                        let copy = words(Ds::get(cx).lang());
                        toast::show(cx, Toast::error(copy.request_failed));
                    }
                }
            },
        );
    }
}

impl Render for CanonTrustDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(grant) = self.grants.first() else {
            return gpui::div().into_any_element();
        };
        let copy = words(Ds::get(cx).lang());
        let person = person_name(cx);
        let row = |label: &'static str, value: String| {
            KeyValueRow::new(label, "")
                .description(value)
                .detail(Detail::Stack)
        };
        let mut body = Stack::new()
            .gap(Space::Sm)
            .child(row(copy.client, grant.client_title.clone()))
            .child(row(copy.person, person.to_string()))
            .child(KeyValueRow::new(copy.requested, "").detail(Detail::Stack));
        for capability in &grant.requested {
            let label = copy
                .capabilities
                .iter()
                .find(|(key, _)| *key == capability.as_str())
                .map_or(capability.as_str(), |(_, label)| label);
            body = body.child(Typo::body(label));
        }
        body = body.child(Notice::new(NoticeTone::Info, (copy.trust_notice)(&person)));
        let (deny, allow) = (cx.entity(), cx.entity());
        let footer = DialogFooter::new().child(
            button::container(Size::Sm)
                .justify(Justify::End)
                .child(
                    self.action("canon-trust-deny", copy.deny, Variant::Ghost, move |cx| {
                        deny.update(cx, |this, cx| this.decide(Decision::Deny, cx));
                    }),
                )
                .child(self.action(
                    "canon-trust-allow",
                    copy.allow,
                    Variant::Default,
                    move |cx| {
                        allow.update(cx, |this, cx| this.decide(Decision::Allow, cx));
                    },
                )),
        );
        let header = DialogHeader::new()
            .child(DialogTitle::new((copy.trust_title)(&grant.client_title)))
            .child(DialogDescription::new(copy.trust_description));
        // Escape and a press outside do not dismiss it (`preventDefault`): only a decision does.
        Dialog::new("canon-trust-dialog", window, cx)
            .open(true)
            .on_open_change(|_, _, _| {})
            .content(
                DialogContent::new()
                    .show_close_button(false)
                    .layout(Layout::ScrollBody)
                    .max_height(MaxHeight::ThreeFifths)
                    .header(header)
                    .child(ScrollArea::new("canon-trust-scroll").fill().child(body))
                    .footer(footer),
                window,
                cx,
            )
            .into_any_element()
    }
}

impl CanonTrustDialog {
    fn action(
        &self,
        id: &'static str,
        label: &'static str,
        variant: Variant,
        on_click: impl Fn(&mut gpui::App) + 'static,
    ) -> Button {
        let button = Button::new(id)
            .size(Size::Sm)
            .variant(variant)
            .text(label)
            .on_click(move |_, _, cx| on_click(cx));
        if self.busy { button.disabled() } else { button }
    }
}
