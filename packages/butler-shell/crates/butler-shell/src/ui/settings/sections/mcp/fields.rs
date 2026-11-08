//! `McpServerForm.tsx`, `StdioFields.tsx`, `HttpFields.tsx`: the add/edit form.
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::layout::Justify;
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::{Input, Textarea};
use gpui::prelude::FluentBuilder as _;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString};

use super::form::{Source, Transport};
use super::secrets::Kind;
use super::{McpPage, Words};

/// A text field of the form: the page keeps the text, every edit writes it back.
fn text_input(
    id: &'static str,
    value: &str,
    set: fn(&mut McpPage, String),
    cx: &mut Context<McpPage>,
) -> Input {
    Input::new(id)
        .value(value.to_owned())
        .on_change(cx.listener(move |this, text: &str, _, cx| {
            set(this, text.to_owned());
            cx.notify();
        }))
}

impl McpPage {
    pub(super) fn form_section(
        &self,
        w: &'static Words,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let title = self.editing.clone().unwrap_or_else(|| w.add.to_owned());
        let mut section = SettingsSection::new("mcp-server-form", SettingsSectionKind::Form, title)
            .holds_fields()
            .child(self.id_field(w, cx))
            .child(self.name_field(w, cx))
            .child(self.transport_field(w, cx))
            .child(self.enabled_field(w, cx));
        let fields = if self.form.transport == Transport::Stdio {
            self.stdio_fields(w, cx)
        } else {
            self.http_fields(w, cx)
        };
        for field in fields {
            section = section.child(field);
        }
        section.child(self.form_buttons(w, cx))
    }

    fn id_field(&self, w: &'static Words, cx: &mut Context<Self>) -> SettingsField {
        let error = self.id_error(w);
        let mut input = text_input(
            "mcp-server-id",
            &self.form.id,
            |this, v| this.form.id = v,
            cx,
        );
        if error.is_some() {
            input = input.invalid();
        }
        let mut field = SettingsField::new(w.server_id).control(input);
        match error {
            Some(error) => field = field.error(error),
            None => {
                let slug = self.form.id.to_lowercase();
                let preview = (w.id_preview)(slug.trim_matches('-'));
                field = field.description(preview);
            }
        }
        field
    }

    fn name_field(&self, w: &'static Words, cx: &mut Context<Self>) -> SettingsField {
        let input = text_input(
            "mcp-server-name",
            &self.form.display_name,
            |this, v| this.form.display_name = v,
            cx,
        );
        SettingsField::new(w.server_name).control(input)
    }

    fn transport_field(&self, w: &'static Words, cx: &mut Context<Self>) -> SettingsField {
        let labels = [w.stdio, w.http, w.sse];
        let select = Transport::ALL.into_iter().zip(labels).fold(
            NativeSelect::new("mcp-transport").value(self.form.transport.as_str()),
            |select, (transport, label)| select.option(transport.as_str(), label),
        );
        let select = select.on_change(cx.listener(|this, value: &str, _, cx| {
            this.form.transport = Transport::parse(value);
            cx.notify();
        }));
        SettingsField::new(w.transport).control(select)
    }

    fn enabled_field(&self, w: &'static Words, cx: &mut Context<Self>) -> SettingsField {
        let switch = Switch::new("mcp-enabled")
            .checked(self.form.enabled)
            .on_checked_change(cx.processor(|this, enabled: bool, _, cx| {
                this.form.enabled = enabled;
                cx.notify();
            }));
        SettingsField::new(w.enabled).control(switch)
    }

    fn stdio_fields(&self, w: &'static Words, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let command = text_input(
            "mcp-stdio-command",
            &self.form.command,
            |this, v| this.form.command = v,
            cx,
        );
        let args = Textarea::new("mcp-stdio-args")
            .placeholder(w.args_placeholder)
            .value(self.form.args_text.clone())
            .on_change(cx.listener(|this, text: &str, _, cx| {
                text.clone_into(&mut this.form.args_text);
                cx.notify();
            }));
        let cwd = text_input(
            "mcp-stdio-cwd",
            &self.form.cwd,
            |this, v| this.form.cwd = v,
            cx,
        );
        vec![
            SettingsField::new(w.command)
                .control(command)
                .into_any_element(),
            SettingsField::new(w.args).control(args).into_any_element(),
            SettingsField::new(w.cwd).control(cwd).into_any_element(),
            self.secrets_field(Kind::Env, w, cx),
        ]
    }

    fn http_fields(&self, w: &'static Words, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let url = text_input(
            "mcp-http-url",
            &self.form.url,
            |this, v| this.form.url = v,
            cx,
        );
        vec![
            SettingsField::new(w.url).control(url).into_any_element(),
            self.secrets_field(Kind::Headers, w, cx),
        ]
    }

    fn form_buttons(&self, w: &'static Words, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.busy;
        let invalid = self.id_error(w).is_some();
        let cancel = Button::new("mcp-form-cancel")
            .variant(Variant::Outline)
            .text(w.cancel)
            .when(busy, Button::disabled)
            .on_click(cx.listener(|this, _, _, cx| this.cancel(cx)));
        let save = Button::new("mcp-form-save")
            .text(w.save)
            .when(busy || invalid, Button::disabled)
            .on_click(cx.listener(|this, _, _, cx| this.save(cx)));
        button::container(Size::Default)
            .justify(Justify::End)
            .child(cancel)
            .child(save)
            .into_any_element()
    }
}

/// The label of a secret source option.
pub(super) fn source_label(source: Source, w: &'static Words) -> SharedString {
    match source {
        Source::Literal => w.literal,
        Source::Env => w.env_reference,
        Source::File => w.file,
    }
    .into()
}
