//! `HookForm.tsx`: the add/edit dialog body.
use butler_ds::ui::button::{self, Button, Size as ButtonSize, Variant};
use butler_ds::ui::dialog::{DialogContent, DialogHeader, DialogTitle};
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::Input;
use gpui::{
    AnyElement, App, Context, IntoElement as _, ParentElement as _, SharedString, WeakEntity,
    Window, prelude::FluentBuilder as _,
};

use super::copy::HooksCopy;
use super::types::{HOOK_EVENTS, HookDefinition, blocking_event};
use super::{HooksPage, tip};
use crate::ui::i18n::settings::Words;

/// The `useState(hook)` and `useState(argv)` of the form, plus the text of the two number and
/// list fields (kept as typed, parsed on save).
pub(super) struct Form {
    pub(super) hook: HookDefinition,
    argv: String,
    tools: String,
    timeout: String,
}

impl Form {
    pub(super) fn new(hook: HookDefinition) -> Self {
        Self {
            argv: hook
                .args
                .as_ref()
                .and_then(|args| serde_json::to_string(args).ok())
                .unwrap_or_default(),
            tools: hook.matcher.tools.join(", "),
            timeout: hook.timeout_ms.to_string(),
            hook,
        }
    }

    fn has_command(&self) -> bool {
        !self.argv.trim().is_empty()
            || self
                .hook
                .command
                .as_deref()
                .is_some_and(|command| !command.trim().is_empty())
    }

    /// The timeout React's number input accepts: a whole number of ms from 1 to 120000 (600000
    /// in the background). `None` blocks Save.
    fn timeout_ms(&self) -> Option<u64> {
        let max = if self.hook.background {
            600_000
        } else {
            120_000
        };
        self.timeout
            .trim()
            .parse()
            .ok()
            .filter(|ms| (1..=max).contains(ms))
    }

    /// `save()`: the edited hook, or `None` when the args are not a JSON list of strings (Save
    /// is blocked while the timeout is out of range).
    pub(super) fn result(&self) -> Option<HookDefinition> {
        let mut hook = self.hook.clone();
        hook.timeout_ms = self.timeout_ms()?;
        hook.matcher.tools = self
            .tools
            .split(',')
            .map(str::trim)
            .filter(|tool| !tool.is_empty())
            .map(str::to_owned)
            .collect();
        if self.argv.trim().is_empty() {
            hook.args = None;
        } else {
            let args = serde_json::from_str::<Vec<String>>(&self.argv)
                .ok()
                .filter(|args| !args.is_empty())?;
            hook.args = Some(args);
            hook.command = None;
        }
        Some(hook)
    }
}

/// A text field's `onChange`: applies the typed text to the form.
fn typed(
    weak: &WeakEntity<HooksPage>,
    apply: fn(&mut Form, &str),
) -> impl Fn(&str, &mut Window, &mut App) + 'static {
    let weak = weak.clone();
    move |text, _, cx| {
        let _ = weak.update(cx, |page, cx| {
            if let Some(form) = &mut page.editing {
                apply(form, text);
                cx.notify();
            }
        });
    }
}

fn field(id: &str, label: &'static str, control: impl gpui::IntoElement) -> AnyElement {
    Field::new(SharedString::from(format!("{id}-field")))
        .child(FieldLabel::new().child(label))
        .child(control)
        .into_any_element()
}

impl HooksPage {
    /// The dialog's content for the hook being edited.
    pub(super) fn form_content(
        &self,
        form: &Form,
        copy: &'static HooksCopy,
        frame: &'static Words,
        cx: &mut Context<Self>,
    ) -> DialogContent {
        let weak = cx.entity().downgrade();
        let key = &form.hook.id;
        let editing = self.hooks().iter().any(|hook| hook.id == form.hook.id);
        let busy = self.busy;
        let id = |name: &str| format!("hook-{name}-{key}");
        let mut fields = vec![
            field(
                &id("name"),
                copy.name,
                Input::new(SharedString::from(id("name")))
                    .value(form.hook.name.clone().unwrap_or_default())
                    .on_change(typed(&weak, |form, text| {
                        form.hook.name = Some(text.to_owned());
                    })),
            ),
            field(
                &id("event"),
                copy.event,
                Self::event_select(form, &id("event"), &weak),
            ),
        ];
        if matches!(form.hook.event.as_str(), "PreToolUse" | "PostToolUse") {
            fields.push(field(
                &id("tools"),
                copy.tools,
                Input::new(SharedString::from(id("tools")))
                    .value(form.tools.clone())
                    .on_change(typed(&weak, |form, text| text.clone_into(&mut form.tools))),
            ));
        }
        let has_args = !form.argv.trim().is_empty();
        let command = Input::new(SharedString::from(id("command")))
            .value(form.hook.command.clone().unwrap_or_default())
            .when(has_args, Input::disabled)
            .on_change(typed(&weak, |form, text| {
                form.hook.command = Some(text.to_owned());
            }));
        fields.push(field(
            &id("command"),
            copy.command,
            tip(
                id("command-tip"),
                has_args.then(|| copy.command_disabled.into()),
                command,
            ),
        ));
        fields.push(field(
            &id("args"),
            copy.args,
            Input::new(SharedString::from(id("args")))
                .value(form.argv.clone())
                .on_change(typed(&weak, |form, text| text.clone_into(&mut form.argv))),
        ));
        // React's number input bounds the value (1 to 120000, 600000 in the background); the DS
        // Input has no number type, so an out-of-range value blocks Save (`Form::timeout_ms`).
        fields.push(field(
            &id("timeout"),
            copy.timeout,
            Input::new(SharedString::from(id("timeout")))
                .value(form.timeout.clone())
                .on_change(typed(&weak, |form, text| {
                    text.clone_into(&mut form.timeout);
                })),
        ));
        fields.push(Self::mode_switch(form, copy, &id("mode"), &weak));
        fields.push(Self::form_buttons(form, copy, frame, busy, cx));
        let title = if editing { copy.edit_title } else { copy.add };
        DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(title)))
            .child(Stack::new().gap(Space::Sm).children(fields))
    }

    /// The event picker: another event clears the tool match, background and fail-closed.
    fn event_select(form: &Form, id: &str, weak: &WeakEntity<HooksPage>) -> NativeSelect {
        let weak = weak.clone();
        let select = NativeSelect::new(SharedString::from(id.to_owned()))
            .stretch()
            .value(form.hook.event.clone())
            .on_change(move |event, _, cx| {
                let _ = weak.update(cx, |page, cx| {
                    if let Some(form) = &mut page.editing {
                        event.clone_into(&mut form.hook.event);
                        form.tools.clear();
                        form.hook.background = false;
                        form.hook.fail_closed = false;
                        cx.notify();
                    }
                });
            });
        HOOK_EVENTS
            .iter()
            .fold(select, |select, event| select.option(*event, *event))
    }

    /// Blocking events choose fail-closed; the others choose background.
    fn mode_switch(
        form: &Form,
        copy: &'static HooksCopy,
        id: &str,
        weak: &WeakEntity<HooksPage>,
    ) -> AnyElement {
        let blocking = blocking_event(&form.hook.event);
        let weak = weak.clone();
        let switch = Switch::new(SharedString::from(id.to_owned()))
            .checked(if blocking {
                form.hook.fail_closed
            } else {
                form.hook.background
            })
            .on_checked_change(move |checked, _, cx| {
                let _ = weak.update(cx, |page, cx| {
                    if let Some(form) = &mut page.editing {
                        if blocking {
                            form.hook.fail_closed = checked;
                        } else {
                            form.hook.background = checked;
                        }
                        cx.notify();
                    }
                });
            });
        let label = if blocking {
            copy.fail_closed
        } else {
            copy.background
        };
        field(id, label, switch)
    }

    /// Cancel and Save, right-aligned.
    fn form_buttons(
        form: &Form,
        copy: &'static HooksCopy,
        frame: &'static Words,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let blocked = busy || !form.has_command() || form.timeout_ms().is_none();
        let reason = if busy {
            Some(frame.saving)
        } else if !form.has_command() {
            Some(copy.command_required)
        } else {
            None
        };
        let cancel = Button::new("hook-form-cancel")
            .variant(Variant::Outline)
            .text(frame.cancel)
            .when(busy, Button::disabled)
            .on_click(cx.listener(|page, _, _, cx| {
                page.editing = None;
                cx.notify();
            }));
        let save = Button::new("hook-form-save")
            .text(copy.save)
            .when(blocked, Button::disabled)
            .on_click(cx.listener(|page, _, _, cx| page.commit(cx)));
        button::container(ButtonSize::Default)
            .justify(Justify::End)
            .child(cancel)
            .child(tip("hook-form-save-tip", reason.map(Into::into), save))
            .into_any_element()
    }
}
