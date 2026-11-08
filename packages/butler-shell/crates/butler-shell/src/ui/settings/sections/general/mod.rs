//! Settings: General (`GeneralSettings.tsx`, `generalPreferenceSections.tsx`,
//! `ConversationInputFields.tsx`, `DefaultPermissionFields.tsx`). The fields read the shared
//! settings and save through `ctx.save`, as React's `update(partial, setSettings)`.
mod access;
mod copy;
mod native;
mod region;
mod search;
mod slice;

use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Ds;
use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, Render, SharedString,
    Window,
};
use serde_json::{Value, json};

use self::copy::{GeneralCopy, words};
use self::slice::{Notifications, Slice};
use crate::ui::settings::controls::{SettingsOption, SettingsSelect, SettingsSwitch};
use crate::ui::settings::{Save, SectionCtx};
use crate::ui::source::wire::AccessMode;

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| GeneralPage::new(ctx, window, cx)).into()
}

struct GeneralPage {
    ctx: SectionCtx,
}

impl GeneralPage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        Self { ctx }
    }
}

impl Render for GeneralPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let page = SettingsPage::new().labels(SectionCtx::labels(cx));
        let Some(slice) = self.ctx.state.read(cx).slice::<Slice>() else {
            return page;
        };
        let ctx = &self.ctx;
        page.section(region::section(ctx, &slice, copy, window, cx))
            .section(conversation_input(ctx, &slice, copy))
            .section(sidebar(ctx, &slice, copy))
            .section(default_permission(ctx, &slice, copy, window, cx))
            .section(notifications(ctx, &slice, copy))
            .section(native::notifications::section(ctx, copy, cx))
            .section(app_behavior(ctx, &slice, copy, cx))
            .section(search::provider(ctx, &slice.web_search, copy, window, cx))
            .section(search::behavior(ctx, &slice.web_search, copy))
            .section(native::full_reset::section(ctx, copy))
    }
}

/// `{key: value}`, or `{parent: {key: value}}`.
fn patch(parent: Option<&str>, key: &str, value: &Value) -> Value {
    match parent {
        Some(parent) => json!({ parent: { key: value } }),
        None => json!({ key: value }),
    }
}

/// `SettingsOption`s from (value, label) pairs.
fn options<L: Into<SharedString> + Clone>(pairs: &[(&'static str, L)]) -> Vec<SettingsOption> {
    pairs
        .iter()
        .map(|(value, label)| SettingsOption::new(*value, label.clone()))
        .collect()
}

/// A select that saves its choice as `patch(parent, key, value)`.
fn select(
    ctx: &SectionCtx,
    id: &'static str,
    label: &'static str,
    value: &str,
    choices: Vec<SettingsOption>,
    parent: Option<&'static str>,
    key: &'static str,
) -> SettingsSelect {
    let ctx = ctx.clone();
    SettingsSelect::new(id, label, value.to_owned())
        .options(choices)
        .on_change(move |value, _, cx| {
            let body = patch(parent, key, &Value::from(value.to_string()));
            ctx.save(body, Save::default(), cx);
        })
}

/// A switch that saves its state as `{key: checked}`.
fn switch(
    ctx: &SectionCtx,
    id: &'static str,
    label: &'static str,
    checked: bool,
    key: &'static str,
) -> SettingsSwitch {
    let ctx = ctx.clone();
    SettingsSwitch::new(id, label)
        .checked(checked)
        .on_change(move |checked, _, cx| {
            ctx.save(patch(None, key, &Value::from(checked)), Save::default(), cx);
        })
}

fn form(id: &'static str, title: &'static str) -> SettingsSection {
    SettingsSection::new(id, SettingsSectionKind::Form, title)
}

/// The modifier of the send shortcut (`nativeShortcutModifier`).
fn shortcut_modifier() -> &'static str {
    if matches!(
        crate::ui::theme::Platform::host(),
        crate::ui::theme::Platform::Mac
    ) {
        "⌘"
    } else {
        "Ctrl"
    }
}

/// `ConversationInputFields`: follow-up handling, send shortcut, plan mode (last).
fn conversation_input(
    ctx: &SectionCtx,
    slice: &Slice,
    copy: &'static GeneralCopy,
) -> SettingsSection {
    let follow_ups = options(&[("queue", copy.follow_ups[0]), ("steer", copy.follow_ups[1])]);
    let sends = options(&[
        (
            "modifier_enter_send_enter_newline",
            SharedString::from((copy.modifier_enter)(shortcut_modifier())),
        ),
        (
            "enter_send_shift_enter_newline",
            SharedString::from(copy.enter_send),
        ),
    ]);
    form("conversation-input", copy.sections[1])
        .child(select(
            ctx,
            "follow-up-behavior",
            copy.follow_up,
            &slice.follow_up_behavior,
            follow_ups,
            None,
            "follow_up_behavior",
        ))
        .child(select(
            ctx,
            "multiline-send",
            copy.multiline_send,
            &slice.multiline_send_behavior,
            sends,
            None,
            "multiline_send_behavior",
        ))
        .child(switch(
            ctx,
            "plan-mode-default",
            copy.plan_mode,
            slice.plan_mode_default,
            "plan_mode_default",
        ))
}

fn sidebar(ctx: &SectionCtx, slice: &Slice, copy: &'static GeneralCopy) -> SettingsSection {
    form("sidebar", copy.sections[2])
        .description(copy.section_descriptions[0])
        .child(
            switch(
                ctx,
                "smart-groups",
                copy.smart_groups[0],
                slice.smart_grouping_enabled,
                "smart_grouping_enabled",
            )
            .description(copy.smart_groups[1]),
        )
}

/// `DefaultPermissionFields`: nothing until the settings carry an access mode.
fn default_permission(
    ctx: &SectionCtx,
    slice: &Slice,
    copy: &'static GeneralCopy,
    window: &mut Window,
    cx: &mut App,
) -> SettingsSection {
    let section = form("default-permission", copy.sections[3]);
    let Some(mode) = &slice.access_mode else {
        return section;
    };
    let available = slice.command_sandbox_available == Some(true);
    let enabled = slice.command_sandbox_enabled.unwrap_or(true);
    let mut sandbox = switch(
        ctx,
        "command-sandbox",
        copy.command_sandbox,
        enabled && available,
        "command_sandbox_enabled",
    )
    .description(copy.descriptions[4])
    .disabled(!available);
    if !available {
        sandbox = sandbox.disabled_reason(copy.descriptions[5]);
    }
    let schedule = slice
        .schedule_access_mode
        .clone()
        .unwrap_or(AccessMode::Auto);
    section
        .child(access::field(
            ctx,
            &access::Field {
                id: "access-mode",
                label: copy.chat_access,
                description: copy.descriptions[2],
                key: "access_mode",
                factory_default: AccessMode::AskExceptReads,
            },
            mode,
            copy,
            window,
            cx,
        ))
        .child(access::field(
            ctx,
            &access::Field {
                id: "schedule-access-mode",
                label: copy.schedule_access,
                description: copy.descriptions[3],
                key: "schedule_access_mode",
                factory_default: AccessMode::Auto,
            },
            &schedule,
            copy,
            window,
            cx,
        ))
        .child(sandbox)
}

/// `notificationSections`: each switch saves the whole `desktop_notifications` object.
fn notifications(ctx: &SectionCtx, slice: &Slice, copy: &'static GeneralCopy) -> SettingsSection {
    let Notifications {
        enabled,
        assistant_messages,
        task_completions,
    } = slice.desktop_notifications;
    let base = json!({
        "enabled": enabled,
        "assistant_messages": assistant_messages,
        "task_completions": task_completions,
    });
    let row = |id: &'static str, index: usize, key: &'static str, checked: bool| {
        let (ctx, base) = (ctx.clone(), base.clone());
        SettingsSwitch::new(id, copy.notifications[index])
            .description(copy.notification_descriptions[index])
            .checked(checked)
            .on_change(move |checked, _, cx| {
                let mut next = base.clone();
                next[key] = Value::from(checked);
                ctx.save(
                    json!({ "desktop_notifications": next }),
                    Save::default(),
                    cx,
                );
            })
    };
    form("notifications", copy.sections[4])
        .child(row("desktop-notifications", 0, "enabled", enabled))
        .child(row(
            "notify-assistant-messages",
            1,
            "assistant_messages",
            assistant_messages,
        ))
        .child(row(
            "notify-task-completions",
            2,
            "task_completions",
            task_completions,
        ))
}

/// App behavior: tray, start at login, rerun setup.
fn app_behavior(
    ctx: &SectionCtx,
    slice: &Slice,
    copy: &'static GeneralCopy,
    cx: &App,
) -> SettingsSection {
    form("app-behavior", copy.sections[6])
        .child(
            switch(
                ctx,
                "desktop-tray",
                copy.desktop_tray,
                slice.desktop_tray_enabled,
                "desktop_tray_enabled",
            )
            .description(copy.descriptions[6]),
        )
        .children(native::login::field(ctx, copy, cx))
        .child(native::rerun::field(ctx, copy))
}
