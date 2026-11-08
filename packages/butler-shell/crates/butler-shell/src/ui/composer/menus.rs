//! `ModelMenu`, `ModelOptions`, `useModelChoice`, `ComposerModelStatusButton`, `AccessModeMenu`,
//! `AccessModeOptions`, `accessModeUtils`, `ComposerPlanModeBadge`, `ComposerWorkspaceSelect`.
//!
//! Each menu is a function over plain props and callbacks: the composer state (unit `state.rs`)
//! owns the values and hears the changes.
pub(crate) mod model;

use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_control::{Compact, ComposerControl, PermissionTone};
use butler_ds::ui::blocks::option_menu::{OptionMenu, OptionMenuItem};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::popover::{MenuSize, Popover, PopoverContent};
use butler_ds::ui::select::{Position, Select, SelectContent, SelectItem};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::tooltip::{Align, Side, Tooltip};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window, div,
};

pub(crate) use model::{
    ModelChoice, ModelFooter, Pick, ReasoningFooterOption, model_display_name, model_options,
    model_options_filter, reasoning_budget_summary, reasoning_option_label, token_window_label,
};

use super::state::{ComposerModelState, WorkspaceMode};
use crate::ui::i18n::composer::access::{AccessText, copy as access_copy};
use crate::ui::source::wire::{AccessMode, ReasoningEffort};

/// Called with the chosen access mode.
pub(crate) type AccessHandler = Rc<dyn Fn(&AccessMode, &mut Window, &mut App)>;
/// Called with the chosen workspace mode.
type WorkspaceHandler = Rc<dyn Fn(WorkspaceMode, &mut Window, &mut App)>;
/// Called with the chosen reasoning effort.
pub(crate) type ReasoningHandler = Rc<dyn Fn(&ReasoningEffort, &mut Window, &mut App)>;

/// `ACCESS_MODES`: the order the access menus list them, the recommended mode first.
pub(crate) const ACCESS_MODES: [AccessMode; 5] = [
    AccessMode::Auto,
    AccessMode::ReadOnly,
    AccessMode::AskFirst,
    AccessMode::AskExceptReads,
    AccessMode::FullAccess,
];

/// `ACCESS_MODE_META`: `ask_first` is Ask every time; `ask_except_reads` is Ask first.
struct AccessMeta {
    tone: PermissionTone,
    glyph: Icon,
}

fn access_meta(mode: &AccessMode) -> AccessMeta {
    let (tone, glyph) = match mode {
        AccessMode::ReadOnly => (PermissionTone::Read, Icon::Eye),
        AccessMode::AskFirst => (PermissionTone::Ask, Icon::CheckList),
        AccessMode::AskExceptReads | AccessMode::Unknown => {
            (PermissionTone::Ask, Icon::ShieldQuestion)
        }
        AccessMode::Auto => (PermissionTone::Ask, Icon::ShieldEnergy),
        AccessMode::FullAccess => (PermissionTone::Full, Icon::ShieldCheck),
    };
    AccessMeta { tone, glyph }
}

fn access_text(mode: &AccessMode, lang: Lang) -> &'static AccessText {
    let copy = access_copy(lang);
    match mode {
        AccessMode::ReadOnly => &copy.read_only,
        AccessMode::AskFirst => &copy.ask_every_time,
        AccessMode::AskExceptReads | AccessMode::Unknown => &copy.ask_first,
        AccessMode::Auto => &copy.auto,
        AccessMode::FullAccess => &copy.full_access,
    }
}

/// `accessPermissionTone`.
pub(crate) fn access_permission_tone(mode: &AccessMode) -> PermissionTone {
    access_meta(mode).tone
}

/// `accessModeIcon`.
pub(crate) fn access_mode_icon(mode: &AccessMode, size: IconSize, ds: &Ds) -> AnyElement {
    icon(access_meta(mode).glyph, size, ds).into_any_element()
}

/// `accessLabel`.
pub(crate) fn access_label(mode: &AccessMode, lang: Lang) -> &'static str {
    access_text(mode, lang).label
}

/// `accessDescription`.
pub(crate) fn access_description(mode: &AccessMode, lang: Lang) -> &'static str {
    access_text(mode, lang).description
}

fn permission_title(lang: Lang) -> &'static str {
    access_copy(lang).permission
}

/// `AccessModeOptions`: the access-mode choices with their labels, descriptions and icons.
/// `onSelect` of a row is `on_select`.
pub(crate) fn access_mode_options(
    id: &'static str,
    value: &AccessMode,
    on_select: &AccessHandler,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let lang = ds.lang();
    let mut menu = OptionMenu::new(permission_title(lang));
    for mode in ACCESS_MODES {
        let select = on_select.clone();
        let chosen = mode.clone();
        let mut item = OptionMenuItem::new(
            (ElementId::from(id), access_label(&mode, lang)),
            access_label(&mode, lang),
        )
        .description(access_description(&mode, lang))
        .block_description()
        .icon(access_mode_icon(&mode, IconSize::Md, ds))
        .permission_tone(access_permission_tone(&mode))
        .on_click(move |_, window, cx| select(&chosen, window, cx));
        if mode == *value {
            item = item.selected();
        }
        menu = menu.child(item);
    }
    menu.into_any_element()
}

/// `AccessModeMenu`: the access control and the popover of its options. Picking a mode calls
/// `on_change` (`handleAccessModeChange`) and closes the menu.
pub(crate) fn access_mode_menu(
    access_mode: &AccessMode,
    on_change: AccessHandler,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let popover = Popover::new("composer-access-menu", window, cx);
    let ds = Ds::get(cx);
    let label = access_label(access_mode, ds.lang());
    let glyph = access_mode_icon(access_mode, IconSize::Md, ds);
    let trigger = popover.trigger(|toggle| {
        ComposerControl::new("access-button", label)
            .icon(glyph)
            .compact(Compact::Icon)
            .permission_tone(access_permission_tone(access_mode))
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let closing = popover.clone();
    let select: AccessHandler = Rc::new(move |mode, window, cx| {
        on_change(mode, window, cx);
        closing.set_open(false, window, cx);
    });
    let options = access_mode_options("composer-access-option", access_mode, &select, cx);
    let content = popover.content(
        PopoverContent::new()
            .align(Align::Start)
            .side(Side::Top)
            .side_offset(10.)
            .menu_size(MenuSize::Compact)
            .child(options),
        window,
        cx,
    );
    div().child(trigger).child(content).into_any_element()
}

/// `ComposerPlanModeBadge`: nothing unless plan mode is on. Its remove button turns it off
/// (`handlePlanModeChange(false)`).
pub(crate) fn plan_mode_badge(
    plan_mode: bool,
    on_cancel: impl Fn(&mut Window, &mut App) + 'static,
    cx: &App,
) -> Option<AnyElement> {
    if !plan_mode {
        return None;
    }
    let lang = Ds::get(cx).lang();
    let plan = access_copy(lang).plan;
    let cancel = access_copy(lang).cancel;
    Some(
        Tag::new("composer-plan-mode-badge", plan)
            .icon(Icon::ListChecks)
            .on_remove(format!("{plan} {cancel}"), move |_, window, cx| {
                on_cancel(window, cx);
            })
            .into_any_element(),
    )
}

/// `ComposerWorkspaceSelect`: a worktree needs Git, so the choice exists only for new chats in
/// a Git project (`git_project`, from `selectIsGitProject(draftProjectId(..))`).
pub(crate) fn workspace_select(
    git_project: bool,
    mode: WorkspaceMode,
    sending: bool,
    on_change: WorkspaceHandler,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if !git_project {
        return None;
    }
    let mut select = Select::new("composer-workspace-select", window, cx).value(Some(
        match mode {
            WorkspaceMode::Local => "local",
            WorkspaceMode::Worktree => "worktree",
        }
        .into(),
    ));
    if sending {
        select = select.disabled();
    }
    let ds = Ds::get(cx);
    let local = access_copy(ds.lang()).local;
    let worktree = access_copy(ds.lang()).worktree;
    let select = select.on_value_change(move |value, window, cx| {
        let next = if value.as_ref() == "worktree" {
            WorkspaceMode::Worktree
        } else {
            WorkspaceMode::Local
        };
        on_change(next, window, cx);
    });
    let (glyph, label) = match mode {
        WorkspaceMode::Worktree => (Icon::GitBranch, worktree),
        WorkspaceMode::Local => (Icon::Monitor, local),
    };
    let mut trigger = ComposerControl::new("composer-workspace-select-control", label).icon(icon(
        glyph,
        IconSize::Sm,
        ds,
    ));
    if sending {
        trigger = trigger.disabled();
    }
    let content = SelectContent::new()
        .position(Position::Popper)
        .child(SelectItem::new("local", local))
        .child(SelectItem::new("worktree", worktree));
    let trigger = select.control_trigger(trigger.into_any_element(), &content);
    let list = select.content(&content, window, cx);
    Some(div().child(trigger).child(list).into_any_element())
}

/// `ComposerModelStatusButton`: the model control while there is no model to pick: still
/// loading, or none added (`model` is a registered model that is not ready).
pub(crate) fn model_status_button(
    state: ComposerModelState,
    model: Option<&ModelChoice>,
    cx: &App,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    if model.is_none() && state != ComposerModelState::Unavailable {
        return ComposerControl::new("model-button", access_copy(lang).checking_model)
            .disabled()
            .into_any_element();
    }
    let label: SharedString = match model {
        Some(model) => model_display_name(model),
        None => access_copy(lang).no_model.into(),
    };
    let hint = match model {
        Some(model) if model.availability.as_deref() == Some("not_in_plan") => {
            access_copy(lang).not_in_plan
        }
        Some(_) => access_copy(lang).sign_in_again,
        None => access_copy(lang).add_model,
    };
    Tooltip::new("model-button-hint")
        .label(hint)
        .child(ComposerControl::new("model-button", label).aria_disabled())
        .into_any_element()
}

/// What `ModelMenu` reads from the composer store and the catalog.
pub(crate) struct ModelMenuProps {
    pub(crate) state: ComposerModelState,
    /// The chosen model; `None` while there is none.
    pub(crate) active: Option<ModelChoice>,
    /// The registered model of `model` when its availability is not ready.
    pub(crate) unavailable: Option<ModelChoice>,
    pub(crate) model: SharedString,
    pub(crate) models: Vec<ModelChoice>,
    pub(crate) reasoning: ReasoningEffort,
    pub(crate) available_reasoning: Vec<ReasoningEffort>,
    /// `handleModelChoice`.
    pub(crate) on_model: Pick,
    /// `handleReasoningChange`.
    pub(crate) on_reasoning: ReasoningHandler,
}

/// `ModelMenu`: the model control and the popover of the models and reasoning choices.
pub(crate) fn model_menu(props: ModelMenuProps, window: &mut Window, cx: &mut App) -> AnyElement {
    // Owned outside the popover, so a reopened menu keeps its search and filter.
    let filter = model_options_filter("composer-model-filter", window, cx);
    let ModelMenuProps {
        state,
        active,
        unavailable,
        model,
        models,
        reasoning,
        available_reasoning,
        on_model,
        on_reasoning,
    } = props;
    let active = match active {
        Some(active) if unavailable.is_none() && state == ComposerModelState::Ready => active,
        _ => return model_status_button(state, unavailable.as_ref(), cx),
    };
    let popover = Popover::new("composer-model-menu", window, cx);
    let lang = Ds::get(cx).lang();
    let summary = reasoning_budget_summary(&active, &reasoning, lang);
    let name = model_display_name(&active);
    let trigger = popover.trigger(|toggle| {
        ComposerControl::new("model-button", name)
            .detail(summary)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let options = available_reasoning
        .iter()
        .map(|item| {
            let (choose, closing, chosen) = (on_reasoning.clone(), popover.clone(), item.clone());
            ReasoningFooterOption {
                label: reasoning_option_label(&active, item, lang).into(),
                selected: *item == reasoning,
                on_select: Rc::new(move |window, cx| {
                    choose(&chosen, window, cx);
                    closing.set_open(false, window, cx);
                }),
            }
        })
        .collect();
    let body = model_options(
        "composer-model-options",
        &models,
        &model,
        &on_model,
        Some(ModelFooter { options }),
        &filter,
        cx,
    );
    let content = popover.content(
        PopoverContent::new()
            .align(Align::End)
            .side(Side::Top)
            .side_offset(10.)
            .menu_size(MenuSize::Fit)
            .child(body),
        window,
        cx,
    );
    div().child(trigger).child(content).into_any_element()
}
