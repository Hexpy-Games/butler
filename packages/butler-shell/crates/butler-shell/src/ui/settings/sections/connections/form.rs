//! Electron `MailAccountForm.tsx`: nullable host overrides preserve the address-derived defaults.
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::layout::{Justify, Stack};
use butler_ds::ui::text::Input;
use butler_ds::ui::tooltip::Tooltip;
use gpui::{
    AnyElement, Context, IntoElement as _, ParentElement as _, prelude::FluentBuilder as _,
};
use serde_json::{Value, json};

use super::{ConnectionsPage, Work, copy::Copy};
use crate::ui::settings::controls::{SettingsOption, SettingsSelect};

#[derive(Default)]
pub(super) struct Form {
    address: String,
    pub(super) password: String,
    imap: Option<String>,
    smtp: Option<String>,
    immediate: bool,
}

impl Form {
    fn host(&self, incoming: bool) -> String {
        let (overridden, prefix) = if incoming {
            (&self.imap, "imap")
        } else {
            (&self.smtp, "smtp")
        };
        overridden.clone().unwrap_or_else(|| {
            let domain = self.address.split('@').nth(1).unwrap_or_default();
            if domain.is_empty() {
                String::new()
            } else {
                format!("{prefix}.{domain}")
            }
        })
    }

    fn ready(&self) -> bool {
        !self.address.trim().is_empty()
            && !self.password.is_empty()
            && !self.host(true).trim().is_empty()
            && !self.host(false).trim().is_empty()
    }

    /// `submit`: keep the password untrimmed and the host/address fields trimmed.
    fn body(&self) -> Value {
        let handling = if self.immediate {
            json!({"mode": "immediate"})
        } else {
            json!({"mode": "batch", "interval_minutes": 10})
        };
        json!({
            "fields": {
                "address": self.address.trim(), "username": "",
                "imap_host": self.host(true).trim(), "imap_port": "", "imap_security": "",
                "smtp_host": self.host(false).trim(), "smtp_port": "", "smtp_security": "",
            },
            "secrets": {"IMAP_PASSWORD": self.password}, "handling": handling,
        })
    }
}

impl ConnectionsPage {
    fn mail_input(
        id: &'static str,
        label: &'static str,
        value: String,
        set: fn(&mut Form, String),
        cx: &mut Context<Self>,
    ) -> SettingsField {
        let input = Input::new(id)
            .value(value)
            .when(id == "mail-password", Input::masked)
            .on_change(cx.listener(move |this, text: &str, _, cx| {
                set(&mut this.form, text.to_owned());
                cx.notify();
            }));
        SettingsField::new(label).setting_id(id).control(input)
    }

    pub(super) fn mail_form(&self, w: &'static Copy, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let address = Self::mail_input(
            "mail-address",
            w.address,
            self.form.address.clone(),
            |form, value| form.address = value,
            cx,
        );
        let password = Self::mail_input(
            "mail-password",
            w.password,
            self.form.password.clone(),
            |form, value| form.password = value,
            cx,
        );
        let imap = Self::mail_input(
            "mail-imap",
            w.incoming,
            self.form.host(true),
            |form, value| form.imap = Some(value),
            cx,
        );
        let smtp = Self::mail_input(
            "mail-smtp",
            w.outgoing,
            self.form.host(false),
            |form, value| form.smtp = Some(value),
            cx,
        );
        let handling = SettingsSelect::new(
            "mail-handling",
            w.handling,
            if self.form.immediate {
                "immediate"
            } else {
                "batch"
            },
        )
        .options(vec![
            SettingsOption::new("batch", w.every_ten_minutes),
            SettingsOption::new("immediate", w.immediate),
        ])
        .on_change(cx.listener(|this, value: &gpui::SharedString, _, cx| {
            this.form.immediate = value.as_ref() == "immediate";
            cx.notify();
        }));
        vec![
            address.into_any_element(),
            password.into_any_element(),
            imap.into_any_element(),
            smtp.into_any_element(),
            handling.into_any_element(),
            self.mail_buttons(w, cx).into_any_element(),
        ]
    }

    fn mail_buttons(&self, w: &'static Copy, cx: &mut Context<Self>) -> Stack {
        let ready = self.form.ready();
        let cancel = Button::new("mail-cancel")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(w.cancel)
            .on_click(cx.listener(|this, _, _, cx| {
                this.adding = false;
                this.form = Form::default();
                cx.notify();
            }));
        let connect = Button::new("mail-connect")
            .size(Size::Sm)
            .text(w.connect)
            .when(!ready || self.busy, Button::disabled)
            .on_click(cx.listener(|this, _, _, cx| {
                if this.form.ready() && !this.busy {
                    this.run(Work::Add(this.form.body()), cx);
                }
            }));
        button::container(Size::Sm)
            .justify(Justify::End)
            .child(cancel)
            .child(
                Tooltip::new("mail-connect-tip")
                    .label(if ready { w.connect } else { w.fill_all })
                    .child(connect),
            )
    }
}
