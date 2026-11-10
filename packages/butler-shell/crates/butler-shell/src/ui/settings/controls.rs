//! The settings controls more than one page uses: `SettingsSwitch`, `SettingsSelect`,
//! `SettingsInput`, `ReasoningSelect` (in [`reasoning`]), `ProviderMark` and
//! `DeveloperLogRawBlock`'s `RawBlock`; the rows are DS `SettingsField`s with React's props as
//! builder methods.
use std::cell::RefCell;
use std::rc::Rc;

use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsField};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::WithItem as _;
use butler_ds::ui::layout::{Basis, Box as DsBox, Inline, MinWidth, Space, Stack, StackItem};
use butler_ds::ui::provider_logo::{ProviderLogo, provider_logo_name};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use butler_ds::ui::select::{Entry, Select, SelectContent, SelectGroup, SelectItem, SelectTrigger};
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::{self, Input};
use butler_ds::ui::tooltip::{Side, Tooltip};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{
    AnyElement, App, ElementId, Entity, Focusable as _, IntoElement, ParentElement as _,
    RenderOnce, SharedString, Styled as _, Window, div,
};

use crate::ui::Icon;

mod reasoning;

pub(crate) use reasoning::ReasoningSelect;

type Toggle = Rc<dyn Fn(bool, &mut Window, &mut App)>;
type Choose = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;
type Commit = Rc<dyn Fn(SharedString, &mut Window, &mut App)>;
/// A decorative glyph before an option's label (a service logo).
pub(crate) type OptionIcon = Rc<dyn Fn() -> AnyElement>;

/// `SettingsSwitch`
#[derive(IntoElement)]
pub(crate) struct SettingsSwitch {
    id: ElementId,
    label: SharedString,
    description: Option<SharedString>,
    checked: bool,
    disabled: bool,
    disabled_reason: Option<SharedString>,
    after_control: Option<AnyElement>,
    on_change: Option<Toggle>,
}

impl SettingsSwitch {
    pub(crate) fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: None,
            checked: false,
            disabled: false,
            disabled_reason: None,
            after_control: None,
            on_change: None,
        }
    }

    pub(crate) fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub(crate) fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub(crate) fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub(crate) fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.disabled_reason = Some(reason.into());
        self
    }

    /// Live state under the switch (a download in progress, a ready line).
    pub(crate) fn after_control(mut self, element: impl IntoElement) -> Self {
        self.after_control = Some(element.into_any_element());
        self
    }

    pub(crate) fn on_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for SettingsSwitch {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let mut switch = Switch::new(self.id).checked(self.checked);
        if self.disabled {
            switch = switch.disabled();
        }
        if let Some(reason) = self.disabled_reason {
            switch = switch.disabled_reason(reason);
        }
        if let Some(handler) = self.on_change {
            switch =
                switch.on_checked_change(move |checked, window, cx| handler(checked, window, cx));
        }
        let mut field = SettingsField::new(self.label).control(switch);
        if let Some(description) = self.description {
            field = field.description(description);
        }
        if let Some(element) = self.after_control {
            field = field.after_control(element);
        }
        field
    }
}

/// An option of a [`SettingsSelect`].
pub(crate) struct SettingsOption {
    pub(crate) value: SharedString,
    pub(crate) label: SharedString,
    pub(crate) description: Option<SharedString>,
    pub(crate) disabled: bool,
    pub(crate) disabled_reason: Option<SharedString>,
    pub(crate) group: Option<SharedString>,
    pub(crate) icon: Option<OptionIcon>,
}

impl SettingsOption {
    pub(crate) fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            description: None,
            disabled: false,
            disabled_reason: None,
            group: None,
            icon: None,
        }
    }
}

/// `optionGroups`: options by group, groups in first-seen order; the ungrouped have no label.
fn option_groups(options: Vec<SettingsOption>) -> SelectContent {
    let mut groups: Vec<(Option<SharedString>, Vec<SettingsOption>)> = Vec::new();
    for option in options {
        match groups.iter().position(|(group, _)| *group == option.group) {
            Some(index) => groups[index].1.push(option),
            None => groups.push((option.group.clone(), vec![option])),
        }
    }
    let mut content = SelectContent::new();
    for (group, options) in groups {
        let mut entry = SelectGroup::new();
        if let Some(label) = group.filter(|label| !label.is_empty()) {
            entry = entry.child(Entry::label(label));
        }
        for option in options {
            // DS gap: SelectItem has no description line and no per-item tooltip, so an
            // option shows its label, and a disabled reason only disables it.
            let mut item = SelectItem::new(option.value, option.label);
            if let Some(glyph) = option.icon {
                item = item.icon(move || glyph());
            }
            if option.disabled || option.disabled_reason.is_some() {
                item = item.disabled();
            }
            entry = entry.child(item);
        }
        content = content.child(entry);
    }
    content
}

/// `SettingsSelect`
#[derive(IntoElement)]
pub(crate) struct SettingsSelect {
    id: SharedString,
    label: SharedString,
    value: SharedString,
    options: Vec<SettingsOption>,
    description: Option<SharedString>,
    disabled: bool,
    disabled_reason: Option<SharedString>,
    control_width: ControlWidth,
    action: Option<AnyElement>,
    on_change: Option<Choose>,
}

impl SettingsSelect {
    pub(crate) fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        value: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            value: value.into(),
            options: Vec::new(),
            description: None,
            disabled: false,
            disabled_reason: None,
            control_width: ControlWidth::Default,
            action: None,
            on_change: None,
        }
    }

    pub(crate) fn options(mut self, options: Vec<SettingsOption>) -> Self {
        self.options = options;
        self
    }

    pub(crate) fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub(crate) fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Disables the control and names why in a tooltip on it.
    pub(crate) fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.disabled_reason = Some(reason.into());
        self
    }

    pub(crate) fn control_width(mut self, width: ControlWidth) -> Self {
        self.control_width = width;
        self
    }

    pub(crate) fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    pub(crate) fn on_change(
        mut self,
        handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for SettingsSelect {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let mut select = Select::new(self.id.clone(), window, cx).value(Some(self.value));
        if self.disabled || self.disabled_reason.is_some() {
            select = select.disabled();
        }
        if let Some(handler) = self.on_change {
            select = select.on_value_change(move |value, window, cx| handler(&value, window, cx));
        }
        let content = option_groups(self.options);
        let trigger_id = format!("{}-trigger", self.id);
        let trigger = select.trigger(SelectTrigger::new(trigger_id.clone()), &content, cx);
        let trigger = match self.disabled_reason {
            Some(reason) => Tooltip::new(format!("{}-reason", self.id))
                .label(reason)
                .side(Side::Right)
                .child(trigger)
                .into_any_element(),
            None => trigger,
        };
        let list = select.content(&content, window, cx);
        let control = crate::ui::widgets::anchor(div(), &trigger_id)
            .child(trigger)
            .child(list);
        let control = match self.action {
            Some(action) => Inline::new()
                .child(
                    StackItem::new()
                        .basis(Basis::Lg)
                        .min_width(MinWidth::Zero)
                        .child(control),
                )
                // React's item holds an inline-flex button whose line box is exactly the
                // button (its text baseline sits inside it). Laid out as a flex item here, the
                // button keeps that height: gpui's inline-flex baseline is the box's bottom, so
                // the strut's descent would add a few px below it.
                .child(
                    StackItem::new()
                        .shrink(false)
                        .child(div().flex().child(action)),
                )
                .into_any_element(),
            None => control.into_any_element(),
        };
        let mut field = SettingsField::new(self.label)
            .control(control)
            .control_width(self.control_width);
        if let Some(description) = self.description {
            field = field.description(description);
        }
        field
    }
}

/// `SettingsInput`: React's `onChange` + `onBlur`. The draft is the field's own text; a new
/// owner `value` resets it, and it commits when the field loses focus.
#[derive(IntoElement)]
pub(crate) struct SettingsInput {
    id: SharedString,
    label: SharedString,
    value: SharedString,
    on_commit: Option<Commit>,
}

impl SettingsInput {
    pub(crate) fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        value: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            value: value.into(),
            on_commit: None,
        }
    }

    pub(crate) fn on_commit(
        mut self,
        handler: impl Fn(SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_commit = Some(Rc::new(handler));
        self
    }
}

/// The draft of field `id`; a new owner `value` resets it.
fn draft(
    id: &ElementId,
    value: &SharedString,
    window: &mut Window,
    cx: &mut App,
) -> Entity<SharedString> {
    let seen = window.use_keyed_state((id.clone(), "seen"), cx, |_, _| value.clone());
    let text = window.use_keyed_state((id.clone(), "draft"), cx, |_, _| value.clone());
    if seen.read(cx) != value {
        seen.update(cx, |seen, _| *seen = value.clone());
        text.update(cx, |text, _| *text = value.clone());
    }
    text
}

/// The field commits its draft when it loses focus; one subscription lives as long as the
/// field and runs the latest handler.
fn blur_commits(
    id: &ElementId,
    draft: &Entity<SharedString>,
    commit: Commit,
    window: &mut Window,
    cx: &mut App,
) {
    type Slot = Rc<RefCell<Option<Commit>>>;
    let slot = window
        .use_keyed_state((id.clone(), "commit"), cx, |_, _| Slot::default())
        .read(cx)
        .clone();
    *slot.borrow_mut() = Some(commit);
    let handle = text::state(id.clone(), window, cx)
        .read(cx)
        .focus_handle(cx);
    let draft = draft.clone();
    window.use_keyed_state((id.clone(), "blur"), cx, move |window, cx| {
        window.on_focus_out(&handle, cx, move |_, window, cx| {
            let commit = slot.borrow().clone();
            if let Some(commit) = commit {
                commit(draft.read(cx).clone(), window, cx);
            }
        })
    });
}

impl RenderOnce for SettingsInput {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = ElementId::from(self.id);
        let text = draft(&id, &self.value, window, cx);
        if let Some(commit) = self.on_commit {
            blur_commits(&id, &text, commit, window, cx);
        }
        let typed = text.clone();
        let input = Input::new(id)
            .value(text.read(cx).clone())
            .on_change(move |value, _, cx| {
                typed.update(cx, |text, cx| {
                    *text = value.to_owned().into();
                    cx.notify();
                });
            });
        SettingsField::new(self.label).control(input)
    }
}

/// `ProviderMark`: a model provider's logo (a local server by its platform); the server icon
/// when it has none. `beside_provider_name` when the label is the provider's name rather than a
/// model's.
pub(crate) fn provider_mark(
    provider_id: &str,
    platform: Option<&str>,
    beside_provider_name: bool,
) -> AnyElement {
    match provider_logo_name(provider_id, platform, beside_provider_name) {
        Some(name) => ProviderLogo::new(name).into_any_element(),
        None => ProviderMark.into_any_element(),
    }
}

/// The neutral server icon of a provider without a logo.
#[derive(IntoElement)]
struct ProviderMark;

impl RenderOnce for ProviderMark {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        icon(Icon::Server, IconSize::Md, Ds::get(cx))
    }
}

/// `RawBlock` (DeveloperLogRawBlock.tsx): a caption over a scrolling block of preformatted text.
/// `id` keys the scroll area (gpui keeps its offset by id).
pub(crate) fn raw_block(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    value: impl Into<SharedString>,
    compact: bool,
    hide_title: bool,
) -> AnyElement {
    let (title, value): (SharedString, SharedString) = (title.into(), value.into());
    let value = if value.is_empty() { "-".into() } else { value };
    let height = if compact {
        MaxHeight::Xs
    } else {
        MaxHeight::Sm
    };
    let block = ScrollArea::new(id).max_height(height).child(
        DsBox::new()
            .padding(Space::Md)
            .child(Typo::code(value).tone(Tone::Primary).wrap(Wrap::Pre)),
    );
    Stack::new()
        .gap(Space::Xs)
        .children((!hide_title).then(|| Typo::caption(title)))
        .child(block)
        .into_any_element()
}
