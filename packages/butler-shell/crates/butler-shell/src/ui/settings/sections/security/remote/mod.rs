//! The remote access section (`SecurityRemoteAccessFields.tsx`, the view half of
//! `useSecuritySettings.ts`, `securityApi.ts` `getSecurity`).
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use butler_shell_client::Error;
use gpui::{Context, ParentElement as _, SharedString};
use serde::Deserialize;
use serde_json::json;

use super::SecurityPage;
use super::copy::Words;
use crate::ui::settings::controls::SettingsSwitch;
use crate::ui::settings::state::fetch;

/// `SecurityLoadState`: `host-only` cannot occur (in-process calls are always local);
/// `admin-required` is the missing admin credential, and Retry reads the file again.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Access {
    Loading,
    Ready,
    AdminRequired,
    Failed,
}

/// `refusedState`: the admin credential is missing (`Error::LocalMetadata`) or the gateway
/// refused it (403; `loopback_required` cannot occur, so a 403 is `admin_credential_required`).
pub(super) fn refused(error: &Error) -> Option<Access> {
    matches!(error, Error::LocalMetadata | Error::Http(403)).then_some(Access::AdminRequired)
}

#[derive(Deserialize)]
struct BindError {
    code: Option<String>,
}

/// `SecurityView`
#[derive(Deserialize)]
pub(super) struct View {
    pub(super) remote_access_enabled: bool,
    #[serde(default)]
    lan_urls: Vec<String>,
    bind_errors: Option<Vec<BindError>>,
    #[serde(default)]
    pub(super) allowed_hosts: Vec<String>,
    pub(super) content_hosts: Option<Vec<String>>,
}

impl SecurityPage {
    /// `refresh`: GET /security.
    pub(super) fn refresh(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_security().await },
            |this: &mut Self, result: Result<View, Error>, cx| match result {
                Ok(view) => {
                    this.access = Access::Ready;
                    let enabled = view.remote_access_enabled;
                    this.view = Some(view);
                    if !enabled {
                        // The pairing and devices sections unmount.
                        this.pairing.reset();
                        this.devices.reset();
                    } else if !this.devices.started() {
                        this.refresh_devices(cx);
                    }
                }
                Err(error) => this.access = refused(&error).unwrap_or(Access::Failed),
            },
        );
    }

    fn set_remote_access(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.save(
            &json!({ "remote_access_enabled": enabled }),
            move |this| {
                if let Some(view) = this.view.as_mut() {
                    view.remote_access_enabled = enabled;
                }
            },
            cx,
        );
    }

    /// `SecuritySettings` remote-access section in all its states.
    pub(super) fn remote_section(&self, copy: &Words, cx: &mut Context<Self>) -> SettingsSection {
        let section = SettingsSection::new(
            "remote-access",
            SettingsSectionKind::Form,
            copy.remote_access_title,
        );
        let retry = cx.listener(|this, _, _, cx| {
            this.access = Access::Loading;
            Self::refresh(cx);
        });
        match (self.access, &self.view) {
            (Access::AdminRequired, _) => section
                .state(SettingsSectionState::Error)
                .error_message(copy.admin_required)
                .on_retry(retry),
            (Access::Failed, _) => section.state(SettingsSectionState::Error).on_retry(retry),
            (_, None) => section.state(SettingsSectionState::Loading),
            (_, Some(view)) => {
                let page = cx.entity().downgrade();
                let switch = SettingsSwitch::new("remote-access-enabled", copy.remote_access)
                    .description(copy.remote_access_description)
                    .checked(view.remote_access_enabled)
                    .disabled(self.busy)
                    .on_change(move |enabled, _, cx| {
                        let _ = page.update(cx, |this, cx| this.set_remote_access(enabled, cx));
                    });
                let addresses = (view.remote_access_enabled || !view.lan_urls.is_empty())
                    .then(|| addresses(view, copy));
                section.holds_fields().child(switch).children(addresses)
            }
        }
    }
}

/// The `lan-urls` field: the addresses, or why there are none.
fn addresses(view: &View, copy: &Words) -> SettingsField {
    let errors = view.bind_errors.as_deref().unwrap_or_default();
    let bind_error = (!errors.is_empty())
        .then(|| copy.bind_error(errors.iter().filter_map(|error| error.code.as_deref())));
    let mut field = SettingsField::new(copy.addresses).setting_id("lan-urls");
    if let Some(error) = bind_error {
        field = field.error(error);
    }
    if view.lan_urls.is_empty() {
        if bind_error.is_none() {
            field = field.control(Typo::caption(copy.no_addresses).tone(Tone::Secondary));
        }
        return field;
    }
    let rows = view.lan_urls.iter().enumerate().map(|(index, url)| {
        let copy_id = SharedString::from(format!("lan-url-copy-{index}"));
        Stack::row()
            .gap(Space::Sm)
            .cross(Cross::Center)
            .child(Typo::code(url.clone()).wrap(Wrap::Anywhere))
            .child(CopyButton::new(copy_id, copy.copy_address, copy.copied).text(url.clone()))
    });
    field.control(Stack::new().gap(Space::Xs).children(rows))
}
