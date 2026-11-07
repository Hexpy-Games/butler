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
    ModelChoice, ModelFooter, ReasoningFooterOption, model_display_name, model_options,
    model_options_filter, reasoning_budget_summary, reasoning_option_label,
};

use crate::ui::source::wire::{AccessMode, ReasoningEffort};

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
    label: (&'static str, &'static str),
    description: (&'static str, &'static str),
}

fn access_meta(mode: &AccessMode) -> AccessMeta {
    match mode {
        AccessMode::ReadOnly => AccessMeta {
            tone: PermissionTone::Read,
            glyph: Icon::Eye,
            label: ("Read only", "읽기 전용"),
            description: ("Can only read files", "파일 읽기만 가능"),
        },
        AccessMode::AskFirst => AccessMeta {
            tone: PermissionTone::Ask,
            glyph: Icon::CheckList,
            label: ("Ask every time", "모두 확인"),
            description: ("Ask before every action", "모든 작업 전에 확인"),
        },
        AccessMode::AskExceptReads | AccessMode::Unknown => AccessMeta {
            tone: PermissionTone::Ask,
            glyph: Icon::ShieldQuestion,
            label: ("Ask first", "먼저 확인"),
            description: ("Ask before changes and commands", "변경·명령 전에 확인"),
        },
        AccessMode::Auto => AccessMeta {
            tone: PermissionTone::Ask,
            glyph: Icon::ShieldEnergy,
            label: ("Auto", "알아서 진행"),
            description: ("Ask only for risky actions", "위험한 작업만 확인"),
        },
        AccessMode::FullAccess => AccessMeta {
            tone: PermissionTone::Full,
            glyph: Icon::ShieldCheck,
            label: ("Full access", "전체 권한"),
            description: ("Never ask", "확인 없이 진행"),
        },
    }
}

fn pick(lang: Lang, pair: (&'static str, &'static str)) -> &'static str {
    if lang == Lang::Ko { pair.1 } else { pair.0 }
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
    pick(lang, access_meta(mode).label)
}

/// `accessDescription`.
pub(crate) fn access_description(mode: &AccessMode, lang: Lang) -> &'static str {
    pick(lang, access_meta(mode).description)
}

fn permission_title(lang: Lang) -> &'static str {
    pick(lang, ("Permission", "권한"))
}

/// `AccessModeOptions`: the access-mode choices with their labels, descriptions and icons.
/// `onSelect` of a row is `on_select`.
pub(crate) fn access_mode_options(
    id: &'static str,
    value: &AccessMode,
    on_select: Rc<dyn Fn(&AccessMode, &mut Window, &mut App)>,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let lang = ds.lang();
    let mut menu = OptionMenu::new(permission_title(lang));
    for mode in ACCESS_MODES {
        let meta = access_meta(&mode);
        let select = on_select.clone();
        let chosen = mode.clone();
        let mut item = OptionMenuItem::new((ElementId::from(id), access_label(&mode, lang)), access_label(&mode, lang))
            .description(access_description(&mode, lang))
            .block_description()
            .icon(icon(meta.glyph, IconSize::Md, ds))
            .permission_tone(meta.tone)
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
    on_change: Rc<dyn Fn(&AccessMode, &mut Window, &mut App)>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let popover = Popover::new("composer-access-menu", window, cx);
    let ds = Ds::get(cx);
    let label = access_label(access_mode, ds.lang());
    let meta = access_meta(access_mode);
    let glyph = icon(meta.glyph, IconSize::Md, ds);
    let trigger = popover.trigger(|toggle| {
        ComposerControl::new("access-button", label)
            .icon(glyph)
            .compact(Compact::Icon)
            .permission_tone(meta.tone)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let closing = popover.clone();
    let options = access_mode_options(
        "composer-access-option",
        access_mode,
        Rc::new(move |mode, window, cx| {
            on_change(mode, window, cx);
            closing.set_open(false, window, cx);
        }),
        cx,
    );
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
    let plan = pick(lang, ("Plan", "계획"));
    let cancel = pick(lang, ("Cancel", "취소"));
    Some(
        Tag::new("composer-plan-mode-badge", plan)
            .icon(Icon::ListChecks)
            .on_remove(format!("{plan} {cancel}"), move |_, window, cx| {
                on_cancel(window, cx);
            })
            .into_any_element(),
    )
}

/// `ComposerWorkspaceSelect`'s `workspaceMode`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceMode {
    Local,
    Worktree,
}

/// `ComposerWorkspaceSelect`: a worktree needs Git, so the choice exists only for new chats in
/// a Git project (`git_project`, from `selectIsGitProject(draftProjectId(..))`).
pub(crate) fn workspace_select(
    git_project: bool,
    mode: WorkspaceMode,
    sending: bool,
    on_change: Rc<dyn Fn(WorkspaceMode, &mut Window, &mut App)>,
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
    let local = pick(ds.lang(), ("Local", "로컬"));
    let worktree = pick(ds.lang(), ("Worktree", "워크트리"));
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
    let mut trigger = ComposerControl::new("composer-workspace-select-control", label)
        .icon(icon(glyph, IconSize::Sm, ds));
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

/// `ComposerModelState` without `error`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelState {
    Loading,
    Ready,
    Unavailable,
}

/// `ComposerModelStatusButton`: the model control while there is no model to pick: still
/// loading, or none added (`model` is a registered model that is not ready).
pub(crate) fn model_status_button(
    state: ModelState,
    model: Option<&ModelChoice>,
    cx: &App,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    if model.is_none() && state != ModelState::Unavailable {
        return ComposerControl::new("model-button", pick(lang, ("Checking model", "모델 확인 중")))
            .disabled()
            .into_any_element();
    }
    let label: SharedString = match model {
        Some(model) => model_display_name(model),
        None => pick(lang, ("No model", "모델 없음")).into(),
    };
    let hint = match model {
        Some(model) if model.availability.as_deref() == Some("not_in_plan") => {
            pick(lang, ("Not in your ChatGPT plan", "ChatGPT 플랜에 없는 모델"))
        }
        Some(_) => pick(lang, ("Sign in to ChatGPT again", "ChatGPT에 다시 로그인하세요")),
        None => pick(lang, ("Add a model in Settings.", "설정에서 모델을 추가해 주세요.")),
    };
    Tooltip::new("model-button-hint")
        .label(hint)
        .child(ComposerControl::new("model-button", label).aria_disabled())
        .into_any_element()
}

/// What `ModelMenu` reads from the composer store and the catalog.
pub(crate) struct ModelMenuProps {
    pub(crate) state: ModelState,
    /// The chosen model; `None` while there is none.
    pub(crate) active: Option<ModelChoice>,
    /// The registered model of `model` when its availability is not ready.
    pub(crate) unavailable: Option<ModelChoice>,
    pub(crate) model: SharedString,
    pub(crate) models: Vec<ModelChoice>,
    pub(crate) reasoning: ReasoningEffort,
    pub(crate) available_reasoning: Vec<ReasoningEffort>,
    /// `handleModelChoice`.
    pub(crate) on_model: Rc<dyn Fn(&ModelChoice, &mut Window, &mut App)>,
    /// `handleReasoningChange`.
    pub(crate) on_reasoning: Rc<dyn Fn(&ReasoningEffort, &mut Window, &mut App)>,
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
        Some(active) if unavailable.is_none() && state == ModelState::Ready => active,
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
        on_model,
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
