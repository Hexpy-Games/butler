//! `CanonConnectedTools.tsx` and `app/canonTrust.ts` (`useCanonGrants`, `decideCanonGrant`): the
//! tools connected to canon, with a revoke or delete button each.
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Box as DsBox, Cross, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::prelude::FluentBuilder as _;
use gpui::{Context, IntoElement as _, ParentElement as _, SharedString};
use serde::Deserialize;
use serde_json::{Value, json};

use super::copy::words;
use super::{McpPage, Words};
use crate::ui::settings::state::fetch;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum State {
    Pending,
    Allowed,
    Denied,
    Revoked,
}

/// `CanonGrant`
#[derive(Deserialize)]
struct Grant {
    id: String,
    client_title: String,
    requested_at: f64,
    state: State,
    #[serde(default)]
    requested: Vec<String>,
    #[serde(default)]
    allowed: Vec<String>,
}

#[derive(Deserialize)]
struct Grants {
    grants: Vec<Grant>,
}

pub(super) struct Canon {
    grants: Option<Vec<Grant>>,
    failed: bool,
    /// The grant being revoked.
    busy: Option<String>,
}

impl Canon {
    pub(super) fn new() -> Self {
        Self {
            grants: None,
            failed: false,
            busy: None,
        }
    }
}

impl McpPage {
    /// `refresh` of `useCanonGrants`: GET /canon/mcp-grants.
    pub(super) fn refresh_grants(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_canon_grants(None).await },
            |this: &mut Self, result: Result<Grants, Error>, cx| match result {
                Ok(list) => {
                    let mut grants: Vec<Grant> = list
                        .grants
                        .into_iter()
                        .filter(|grant| grant.state != State::Revoked)
                        .collect();
                    grants.sort_by(|a, b| {
                        a.requested_at
                            .total_cmp(&b.requested_at)
                            .then_with(|| a.id.cmp(&b.id))
                    });
                    this.canon.grants = Some(grants);
                    this.canon.failed = false;
                }
                Err(_) => {
                    this.canon.failed = true;
                    let message = words(Ds::get(cx).lang()).request_failed;
                    toast::show(cx, Toast::error(message));
                }
            },
        );
    }

    fn revoke_grant(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(denied) = self
            .canon
            .grants
            .iter()
            .flatten()
            .find(|grant| grant.id == id)
            .map(|grant| grant.state == State::Denied)
        else {
            return;
        };
        if self.canon.busy.is_some() {
            return;
        }
        self.canon.busy = Some(id.to_owned());
        cx.notify();
        let id = id.to_owned();
        fetch(
            cx,
            move |client| async move { client.revoke_canon_grant(&id, &json!({})).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.canon.busy = None;
                let w = words(Ds::get(cx).lang());
                match result {
                    Ok(_) => {
                        Self::refresh_grants(cx);
                        let done = if denied { w.deleted } else { w.revoked };
                        toast::show(cx, Toast::message(done));
                    }
                    Err(_) => {
                        toast::show(cx, Toast::error(w.request_failed));
                    }
                }
            },
        );
    }

    pub(super) fn canon_section(
        &self,
        w: &'static Words,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let state = match (&self.canon.grants, self.canon.failed) {
            (_, true) => SettingsSectionState::Error,
            (None, false) => SettingsSectionState::Loading,
            (Some(grants), false) if grants.is_empty() => SettingsSectionState::Empty,
            (Some(_), false) => SettingsSectionState::Ready,
        };
        let mut section = SettingsSection::new(
            "canon-connected-tools",
            SettingsSectionKind::List,
            w.connected_tools,
        )
        .state(state)
        .empty_message(w.no_tools)
        .on_retry(cx.listener(|_, _, _, cx| Self::refresh_grants(cx)));
        for grant in self.canon.grants.iter().flatten() {
            section = section.child(self.grant_row(grant, w, cx));
        }
        section
    }

    fn grant_row(
        &self,
        grant: &Grant,
        w: &'static Words,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let count = if grant.state == State::Allowed {
            grant.allowed.len()
        } else {
            grant.requested.len()
        };
        let label = match grant.state {
            State::Allowed => w.states[0],
            State::Pending => w.states[1],
            State::Denied => w.states[2],
            State::Revoked => w.states[3],
        };
        let action = if grant.state == State::Denied {
            w.remove
        } else {
            w.revoke
        };
        let id = grant.id.clone();
        let button = Button::new(SharedString::from(format!("canon-grant-{id}-revoke")))
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(action)
            .when(self.canon.busy.is_some(), Button::disabled)
            .on_click(cx.listener(move |this, _, _, cx| this.revoke_grant(&id, cx)));
        let title =
            ListRow::new(grant.client_title.clone()).description((w.capability_count)(count));
        Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .wrap(true)
            .child(DsBox::new().grow().min_width(MinWidth::Zero).child(title))
            .child(Tag::new(
                SharedString::from(format!("canon-grant-{}-state", grant.id)),
                label,
            ))
            .child(button)
            .into_any_element()
    }
}
