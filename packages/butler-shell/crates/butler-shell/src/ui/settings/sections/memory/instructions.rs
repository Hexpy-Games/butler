//! `useInstructions`, `InstructionsSection` and `InstructionRow`: the standing instructions,
//! each deletable after a confirmation.
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::context::Lang;
use butler_ds::ui::expandable_text::ExpandableText;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::toast::Toast;
use butler_shell_client::Error;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString};
use serde_json::{Value, json};

use super::copy::{Words, words};
use super::facts::memory_facts;
use super::format::{instruction_duration, instruction_scope};
use super::reset::ResetKind;
use super::types::{Instruction, InstructionList};
use super::{MemoryPage, lang};
use crate::ui::Icon;
use crate::ui::settings::confirm::{Detail, Request};
use crate::ui::settings::state::{Load, fetch};

pub(super) struct Instructions {
    rows: Load<Vec<Instruction>>,
    /// The agent has no instructions route (404).
    unavailable: bool,
    /// The handle being deleted.
    deleting: Option<String>,
}

impl Instructions {
    pub(super) fn new() -> Self {
        Self {
            rows: Load::Loading,
            unavailable: false,
            deleting: None,
        }
    }
}

impl MemoryPage {
    /// `instructions.reload`: GET /memory/instructions. `quiet` keeps the rows on a failure.
    pub(super) fn reload_instructions(quiet: bool, cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.list_memory_instructions().await },
            move |this: &mut Self, result: Result<InstructionList, Error>, _| match result {
                Ok(list) => {
                    this.instructions.unavailable = false;
                    this.instructions.rows = Load::Ready(list.instructions);
                }
                Err(error) if !quiet => {
                    this.instructions.unavailable = matches!(error, Error::Http(404));
                    this.instructions.rows = Load::Failed;
                }
                Err(_) => {}
            },
        );
    }

    /// `remove`: confirms, then deletes.
    fn ask_delete_instruction(&mut self, item: Instruction, cx: &mut Context<Self>) {
        if self.instructions.deleting.is_some() {
            return;
        }
        let copy = words(lang(cx));
        let request = Request::new(copy.chats_kept)
            .title(copy.delete_instruction_title)
            .confirm_label(copy.delete)
            .destructive()
            .detail(Detail {
                label: None,
                text: item.text.clone().into(),
                caption: Some(instruction_scope(&item, copy).into()),
            });
        let page = cx.weak_entity();
        self.ctx.confirm(
            request,
            move |_, cx| {
                let _ = page.update(cx, |this, cx| this.delete_instruction(item, cx));
            },
            cx,
        );
    }

    fn delete_instruction(&mut self, item: Instruction, cx: &mut Context<Self>) {
        self.instructions.deleting = Some(item.handle.clone());
        let body = json!({
            "expected_revision": item.revision,
            "project_id": item.project_id,
            "operation_id": uuid::Uuid::new_v4().to_string(),
        });
        let handle = item.handle;
        fetch(
            cx,
            move |client| async move { client.delete_memory_instruction(&handle, &body).await },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.instructions.deleting = None;
                let copy = words(lang(cx));
                if result.is_ok() {
                    this.notify("instruction", Toast::success(copy.instruction_deleted), cx);
                    Self::reload_instructions(true, cx);
                    this.reload_summary(cx);
                } else {
                    this.notify("instruction", Toast::error(copy.delete_failed), cx);
                }
            },
        );
    }

    fn instruction_row(
        &self,
        item: &Instruction,
        locked: bool,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let deleting = self.instructions.deleting.as_deref() == Some(item.handle.as_str());
        let busy = locked || self.instructions.deleting.is_some();
        let duration = instruction_duration(item, copy, lang);
        let meta = if item.scope.kind == "session" && item.duration.as_deref() == Some("this chat")
        {
            duration
        } else {
            let tail = if item.duration.as_deref() == Some("always") {
                String::new()
            } else {
                duration
            };
            [instruction_scope(item, copy), tail]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" · ")
        };
        let reason = if locked { copy.in_use } else { copy.deleting };
        let label = if busy {
            format!("{} · {reason}", copy.delete)
        } else {
            copy.delete.to_owned()
        };
        let id = |prefix: &str| SharedString::from(format!("{prefix}-{}", item.handle));
        let mut text =
            ExpandableText::new(id("instruction-text"), item.text.clone()).collapsed_lines(1);
        if !meta.is_empty() {
            text = text.meta(meta);
        }
        let mut delete = IconButton::new(id("instruction-delete"), label);
        delete = if deleting {
            delete.icon(Spinner::new(id("instruction-spinner")).size(14.))
        } else {
            delete.glyph(Icon::Trash2)
        };
        if busy {
            delete = delete.disabled();
        }
        let target = item.clone();
        let delete = delete.on_click(cx.listener(move |this, _, _, cx| {
            this.ask_delete_instruction(target.clone(), cx);
        }));
        Stack::row()
            .cross(Cross::Start)
            .gap(Space::Md)
            .child(
                StackItem::new()
                    .grow()
                    .min_width(MinWidth::Zero)
                    .child(text),
            )
            .child(delete)
            .into_any_element()
    }

    pub(super) fn instructions_section(
        &self,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let locked = self.reset.kind() == Some(ResetKind::Project);
        let state = if self.instructions.unavailable {
            SettingsSectionState::Empty
        } else {
            self.instructions.rows.state(std::vec::Vec::is_empty)
        };
        let empty = if self.instructions.unavailable {
            copy.unavailable
        } else {
            copy.instructions_empty
        };
        let mut section =
            SettingsSection::new("instructions", SettingsSectionKind::Form, copy.titles[0])
                .description(copy.descriptions[0])
                .state(state)
                .empty_message(empty)
                .on_retry(cx.listener(|_, _, _, cx| Self::reload_instructions(false, cx)));
        if let Load::Ready(rows) = &self.instructions.rows
            && !rows.is_empty()
        {
            let mut items: Vec<AnyElement> = Vec::new();
            for (index, item) in rows.iter().enumerate() {
                if index > 0 {
                    items.push(Separator::new().space(Space::None).into_any_element());
                }
                items.push(self.instruction_row(item, locked, copy, lang, cx));
            }
            section = section
                .child(memory_facts(self.card("pinned"), None, copy, lang))
                .child(
                    ScrollArea::new("instruction-list")
                        .max_height(MaxHeight::Sm)
                        .child(Stack::new().gap(Space::Md).children(items)),
                );
        }
        section
    }
}
