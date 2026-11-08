//! `McpSecretRows.tsx`, `mcpSecretRowsUtils.ts`: the editable env / header rows of a server.
use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsField};
use butler_ds::ui::blocks::settings_secret_rows::{
    SettingsSecretRow, SettingsSecretRows, source_cell,
};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use butler_ds::ui::text::Input;
use gpui::prelude::FluentBuilder as _;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString};

use super::fields::source_label;
use super::form::{FormState, SecretGroup, SecretRow, Source};
use super::{McpPage, Words};
use crate::ui::Icon;

/// Which secret map of the form: `StdioFields` env or `HttpFields` headers.
#[derive(Clone, Copy)]
pub(super) enum Kind {
    Env,
    Headers,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Headers => "headers",
        }
    }

    fn title(self, w: &Words) -> &'static str {
        match self {
            Self::Env => w.env,
            Self::Headers => w.headers,
        }
    }

    fn add_label(self, w: &Words) -> &'static str {
        match self {
            Self::Env => w.add_environment,
            Self::Headers => w.add_header,
        }
    }

    fn group(self, form: &FormState) -> &SecretGroup {
        match self {
            Self::Env => &form.env,
            Self::Headers => &form.headers,
        }
    }
}

/// `mcpSecretValuePlaceholder`
fn value_placeholder(row: &SecretRow, w: &Words) -> SharedString {
    if row.redacted && !row.missing {
        return w.secret_placeholder.into();
    }
    match row.source {
        Source::Env => "ENV_VAR",
        Source::File => "/path/to/secret",
        Source::Literal => "VALUE",
    }
    .into()
}

fn source_select(id: String, source: Source, w: &'static Words) -> NativeSelect {
    Source::ALL.into_iter().fold(
        NativeSelect::new(SharedString::from(id)).value(source.as_str()),
        |select, option| select.option(option.as_str(), source_label(option, w)),
    )
}

impl McpPage {
    pub(super) fn secrets_field(
        &self,
        kind: Kind,
        w: &'static Words,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        SettingsField::new(kind.title(w))
            .description(w.secrets)
            .control_width(ControlWidth::Full)
            .control(self.secret_rows(kind, w, cx))
            .into_any_element()
    }

    /// `onRowsChange`: the rows changed, so the map is sent on save.
    fn edit_secrets(
        &mut self,
        kind: Kind,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut SecretGroup, &mut u32),
    ) {
        let FormState {
            env,
            headers,
            next_row,
            ..
        } = &mut self.form;
        let group = match kind {
            Kind::Env => env,
            Kind::Headers => headers,
        };
        f(group, next_row);
        group.sync();
        group.dirty = true;
        cx.notify();
    }

    fn edit_row(
        &mut self,
        kind: Kind,
        id: u32,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut SecretRow),
    ) {
        self.edit_secrets(kind, cx, |group, _| {
            if let Some(row) = group.rows.iter_mut().find(|row| row.id == id) {
                f(row);
            }
        });
    }

    fn secret_rows(
        &self,
        kind: Kind,
        w: &'static Words,
        cx: &mut Context<Self>,
    ) -> SettingsSecretRows {
        let group = kind.group(&self.form);
        let (title, key) = (kind.title(w), kind.key());
        let selected = source_select(format!("mcp-{key}-default-source"), group.selected, w)
            .size(SelectSize::Sm)
            .stretch()
            .on_change(cx.listener(move |this, value: &str, _, cx| {
                let source = Source::parse(value);
                let FormState { env, headers, .. } = &mut this.form;
                match kind {
                    Kind::Env => env.selected = source,
                    Kind::Headers => headers.selected = source,
                }
                cx.notify();
            }));
        let all_selected = group.rows.iter().all(|row| row.source == group.selected);
        let apply = Button::new(SharedString::from(format!("mcp-{key}-apply-all")))
            .size(Size::Xs)
            .variant(Variant::Outline)
            .text(w.apply_all)
            .when(all_selected, Button::disabled)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.edit_secrets(kind, cx, |group, _| {
                    let source = group.selected;
                    group.rows.iter_mut().for_each(|row| row.source = source);
                });
            }));
        let add = Button::new(SharedString::from(format!("mcp-{key}-add")))
            .size(Size::Xs)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::Plus, IconSize::Sm, Ds::get(cx)))
            .text(kind.add_label(w))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.edit_secrets(kind, cx, super::form::SecretGroup::add);
            }));
        let rows: Vec<_> = group
            .rows
            .iter()
            .map(|row| Self::secret_row(kind, row, w, cx))
            .collect();
        let mut block =
            SettingsSecretRows::new(SharedString::from(format!("mcp-{key}-rows")), title)
                .action(source_cell(selected))
                .action(button::container(Size::Xs).child(apply).child(add))
                .rows(rows);
        if group.rows.is_empty() {
            block = block.empty_state(w.no_entries);
        }
        block
    }

    fn secret_row(
        kind: Kind,
        row: &SecretRow,
        w: &'static Words,
        cx: &mut Context<Self>,
    ) -> SettingsSecretRow {
        let (id, key) = (row.id, kind.key());
        let source = source_select(format!("mcp-{key}-{id}-source"), row.source, w)
            .stretch()
            .on_change(cx.listener(move |this, value: &str, _, cx| {
                this.edit_row(kind, id, cx, |row| row.source = Source::parse(value));
            }));
        let name = Input::new(SharedString::from(format!("mcp-{key}-{id}-key")))
            .placeholder("KEY")
            .value(row.key.clone())
            .on_change(cx.listener(move |this, text: &str, _, cx| {
                this.edit_row(kind, id, cx, |row| text.clone_into(&mut row.key));
            }));
        let value = Input::new(SharedString::from(format!("mcp-{key}-{id}-value")))
            .placeholder(value_placeholder(row, w))
            .value(row.value.clone())
            .on_change(cx.listener(move |this, text: &str, _, cx| {
                this.edit_row(kind, id, cx, |row| text.clone_into(&mut row.value));
            }));
        let delete = IconButton::new(
            SharedString::from(format!("mcp-{key}-{id}-delete")),
            (w.delete_row)(kind.title(w)),
        )
        .glyph(Icon::Trash2)
        .on_click(cx.listener(move |this, _, _, cx| {
            this.edit_secrets(kind, cx, |group, _| group.rows.retain(|row| row.id != id));
        }));
        SettingsSecretRow::new(source, name, value, delete)
    }
}
