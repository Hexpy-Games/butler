//! The toolbar, the editor slots and the controls of the composer card (ComposerCard.tsx,
//! ComposerCardEditor.tsx, ComposerSendButton.tsx, ComposerPlanToggle.tsx).
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement as _, IntoElement, ParentElement,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::blocks::scope;
use crate::ui::collapsible::{Collapsible, KeepMounted};
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, Disabled, DisabledLook, Width};
use crate::ui::icon::{IconSize, icon};
use crate::ui::spinner::Spinner;
use crate::ui::switch::Switch;
use crate::ui::text::{Textarea, TextareaVariant};
use crate::ui::tooltip::{Align, Side, Tooltip};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

fn vars(cx: &App) -> scope::ComposerVars {
    scope::composer(cx).unwrap_or(scope::ComposerVars {
        narrow: false,
        padding: (0., 0.),
        expanded: true,
    })
}

/// `ComposerCardToolbar`: a row of controls over a divider. Folded, the divider is clear and the
/// row is one hit target and a gap tall.
#[derive(IntoElement, Default)]
pub struct Toolbar {
    children: Vec<AnyElement>,
}

impl Toolbar {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for Toolbar {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Toolbar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let (ds, vars) = (Ds::get(cx), vars(cx));
        let hit = ds.len(Length::ControlHitTarget);
        let min = match (vars.expanded, vars.narrow) {
            (false, _) => hit + ds.len(Length::SpaceSm),
            (true, true) => hit,
            (true, false) => px(42.), // DS: ComposerCard.module.css:152
        };
        let border = if vars.expanded {
            ds.color(Color::ComposerGlassDivider)
        } else {
            gpui::transparent_black()
        };
        let pad = if vars.narrow && ds.compact() {
            ds.len(Length::SpaceXs)
        } else {
            ds.len(Length::Space2)
        };
        div()
            .flex()
            .items_center()
            .min_h(min)
            .gap(if vars.narrow {
                px(2.)
            } else {
                ds.len(Length::Space1)
            })
            .min_w_0()
            .p(pad)
            .border_t(ds.len(Length::BorderHairline))
            .border_color(border)
            .children(self.children)
    }
}

/// `ComposerCardExpandedControls`: shown only while the card is expanded.
#[derive(IntoElement, Default)]
pub struct ExpandedControls {
    children: Vec<AnyElement>,
}

impl ExpandedControls {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for ExpandedControls {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ExpandedControls {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        // `display: contents` in CSS: the controls are the toolbar's own items. Here they share a
        // row that takes the toolbar's room, so a spacer inside it still reaches the send button.
        let (ds, vars) = (Ds::get(cx), vars(cx));
        if !vars.expanded {
            return div().into_any_element();
        }
        div()
            .flex()
            .flex_1()
            .items_center()
            .min_w_0()
            .gap(if vars.narrow {
                px(2.)
            } else {
                ds.len(Length::Space1)
            })
            .children(self.children)
            .into_any_element()
    }
}

/// `ComposerCardToolbarSpacer`.
#[derive(IntoElement)]
pub struct ToolbarSpacer;

impl RenderOnce for ToolbarSpacer {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div().flex_1().min_w(Ds::get(cx).len(Length::SpaceSm))
    }
}

/// `ComposerCardExpandedBody`: the editor region, revealed by a Collapsible and kept mounted
/// (focusable) while folded.
#[derive(IntoElement)]
pub struct ExpandedBody {
    id: ElementId,
    children: Vec<AnyElement>,
}

impl ExpandedBody {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            children: Vec::new(),
        }
    }
}

impl ParentElement for ExpandedBody {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ExpandedBody {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        Collapsible::new(self.id, vars(cx).expanded)
            .keep_mounted(KeepMounted::Focusable)
            .child(div().min_w_0().children(self.children))
    }
}

/// `ComposerCardCompactPreview`: the one-line preview of a folded card, in the place of the
/// controls; it gives way first, so its ellipsis applies.
#[derive(IntoElement)]
pub struct CompactPreview {
    id: ElementId,
    text: SharedString,
    empty: bool,
    on_click: Option<Handler>,
}

impl CompactPreview {
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            empty: false,
            on_click: None,
        }
    }

    /// The draft is empty: the text is the placeholder.
    pub fn empty(mut self) -> Self {
        self.empty = true;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for CompactPreview {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        if vars(cx).expanded {
            return div().into_any_element();
        }
        let color = if self.empty {
            Color::Placeholder
        } else {
            Color::TextPrimary
        };
        let mut el = div()
            .id(self.id)
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .px(ds.len(Length::SpaceSm))
            .text_color(ds.color(color))
            .whitespace_nowrap()
            .text_ellipsis()
            .cursor_pointer();
        if let Some(handler) = self.on_click {
            el = el.on_click(move |event, window, cx| handler(event, window, cx));
        }
        el.child(self.text).into_any_element()
    }
}

type ChangeHandler = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// `ComposerPlanToggle`: a pill label around a Switch. In a narrow composer only the Switch
/// shows.
#[derive(IntoElement)]
pub struct PlanToggle {
    id: ElementId,
    checked: bool,
    label: SharedString,
    on_change: Option<ChangeHandler>,
}

impl PlanToggle {
    pub fn new(id: impl Into<ElementId>, checked: bool, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            checked,
            label: label.into(),
            on_change: None,
        }
    }

    pub fn on_checked_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for PlanToggle {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let (ds, narrow) = (Ds::get(cx), vars(cx).narrow);
        let hit = ds.len(Length::ControlHitTarget);
        let switch = {
            let mut switch = Switch::new((self.id.clone(), "switch")).checked(self.checked);
            if let Some(handler) = self.on_change.clone() {
                switch =
                    switch.on_checked_change(move |value, window, cx| handler(value, window, cx));
            }
            switch
        };
        let toggle = self.on_change.clone();
        let checked = self.checked;
        let label = (!narrow).then(|| {
            div()
                .id((self.id.clone(), "label"))
                .text_size(ds.len(Length::FontSize2))
                .line_height(ds.len(Length::TypoLabelLineHeight))
                .text_color(ds.color(Color::TextSecondary))
                .cursor_pointer()
                .on_click(move |_, window, cx| {
                    if let Some(toggle) = &toggle {
                        toggle(!checked, window, cx);
                    }
                })
                .child(self.label)
        });
        let hover = ds.color(Color::ComposerGlassControlBg);
        div()
            .id((self.id, "plan"))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(ds.len(Length::Space1))
            .min_h(px(30.)) // DS: ComposerCard.module.css:226
            .px(if narrow {
                ds.len(Length::SpaceXs)
            } else {
                ds.len(Length::Space2)
            })
            .min_w(if narrow { hit } else { px(0.) })
            .overflow_hidden()
            .rounded(ds.len(Length::RadiusPill))
            .hover_style(move |style| style.bg(hover))
            .child(switch)
            .children(label)
    }
}

/// `mode`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SendMode {
    #[default]
    Send,
    Stop,
}

/// `ComposerSendButton`: the round send or stop button; busy shows a spinner; a disabled reason
/// keeps the button hoverable and names why in a tooltip.
#[derive(IntoElement)]
pub struct SendButton {
    id: ElementId,
    mode: SendMode,
    busy: bool,
    disabled: bool,
    reason: Option<(SharedString, Side, Align)>,
    on_click: Option<Handler>,
}

impl SendButton {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            mode: SendMode::Send,
            busy: false,
            disabled: false,
            reason: None,
            on_click: None,
        }
    }

    pub fn mode(mut self, mode: SendMode) -> Self {
        self.mode = mode;
        self
    }

    pub fn busy(mut self) -> Self {
        self.busy = true;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Blocks sending and names why in a short tooltip (default side top, align center).
    pub fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.reason = Some((reason.into(), Side::Top, Align::Center));
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for SendButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let (ds, narrow) = (Ds::get(cx), vars(cx).narrow);
        let blocked = self.reason.is_some() && !self.busy;
        let side = if narrow {
            ds.len(Length::ControlHitTarget)
        } else {
            px(30.) // DS: ComposerCard.module.css:240
        };
        let mut control = Control::new(self.id.clone(), ds);
        control.width = Width::Fixed(f32::from(side));
        control.height = Some(side);
        control.radius = ds.len(Length::RadiusPill);
        control.scale = false;
        let off = self.busy || self.disabled || blocked;
        control.fill = Blend::flat(ds.color(match (off, self.mode) {
            (true, _) => Color::SendDisabledBg,
            (false, SendMode::Stop) => Color::SendStopBg,
            (false, SendMode::Send) => Color::SendBg,
        }));
        control.fg = Blend::flat(ds.color(if self.busy {
            Color::TextSecondary
        } else {
            Color::SendFg
        }));
        control.disabled = match (self.busy, blocked, self.disabled) {
            (true, _, _) | (_, false, true) => Disabled::Native,
            (_, true, _) => Disabled::Aria,
            _ => Disabled::No,
        };
        control.disabled_look = DisabledLook::Opacity(if self.busy { 1. } else { 0.56 }); // DS: ComposerCard.module.css:262
        control.not_allowed = true;
        control.on_click(if blocked { None } else { self.on_click });
        control.children = vec![match (self.busy, self.mode) {
            (true, _) => Spinner::new((self.id.clone(), "busy"))
                .size(16.)
                .into_any_element(),
            (false, SendMode::Stop) => icon(Icon::Square, IconSize::Sm, ds).into_any_element(),
            (false, SendMode::Send) => {
                icon(Icon::SendHorizontal, IconSize::Md, ds).into_any_element()
            }
        }];
        match self.reason.filter(|_| blocked) {
            Some((reason, side, align)) => Tooltip::new((self.id, "reason"))
                .label(reason)
                .side(side)
                .align(align)
                .child(control)
                .into_any_element(),
            None => control.into_any_element(),
        }
    }
}

/// `ComposerCardEditor`: the editor region (its placeholder is laid over it).
pub fn editor(children: impl IntoIterator<Item = AnyElement>) -> gpui::Div {
    div().relative().min_w_0().children(children)
}

/// `ComposerCardPlaceholder`: the placeholder over an empty editor, inside the card's padding.
pub fn placeholder(text: impl Into<SharedString>, cx: &App) -> AnyElement {
    let (ds, vars) = (Ds::get(cx), vars(cx));
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .px(px(vars.padding.0))
        .py(px(vars.padding.1))
        .text_color(ds.color(Color::Placeholder))
        .line_height(ds.len(Length::TypoBodyLineHeight))
        .child(text.into())
        .into_any_element()
}

/// `ComposerCardTextarea`: a bare textarea, padded by the card, two rows like an HTML textarea
/// (`rows(1)` for one), growing to eight lines.
pub fn textarea(id: impl Into<ElementId>) -> Textarea {
    Textarea::new(id).variant(TextareaVariant::Bare).rows(2)
}
