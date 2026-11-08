//! DS SetupWizardStepCard (SetupWizardStepCard.tsx / .module.css): one step of a focus-variant
//! setup flow. A header row (back, steps), a title on the content's left edge, the step's content
//! and a footer row (status, right-aligned large actions).
//!
//! The wide solid frame (`SetupWizardContent width="wide" surface="solid"`) and the step strip
//! (`SetupWizardProgress`) belong to the SetupWizardShell block: the caller passes the built strip
//! to [`SetupWizardStepCard::progress`] and wraps the returned card in `SetupWizardContent`.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FocusHandle, InteractiveElement as _, IntoElement,
    ParentElement, RenderOnce, SharedString, Styled, Window, div,
};

use crate::tokens::{Duration, Easing, Length};
use crate::ui::Icon;
use crate::ui::button::{self, Button, Size, Variant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use crate::ui::motion::{Timing, Tween};
use crate::ui::typo::{Tone, Typo};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A footer action of a setup step: large and content-width; `forward` adds the trailing arrow
/// and the primary look.
#[derive(IntoElement)]
pub struct SetupWizardStepAction {
    id: ElementId,
    text: SharedString,
    forward: bool,
    variant: Option<Variant>,
    disabled: bool,
    on_click: Option<Handler>,
}

impl SetupWizardStepAction {
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            forward: false,
            variant: None,
            disabled: false,
            on_click: None,
        }
    }

    /// The action that moves the flow on: primary, with a trailing arrow.
    pub fn forward(mut self) -> Self {
        self.forward = true;
        self
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = Some(variant);
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
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

impl RenderOnce for SetupWizardStepAction {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let default = if self.forward {
            Variant::Default
        } else {
            Variant::Outline
        };
        let mut button = Button::new(self.id)
            .size(Size::Lg)
            .variant(self.variant.unwrap_or(default))
            .text(self.text);
        if self.forward {
            button = button.icon_end(icon(Icon::ArrowRight, IconSize::Md, Ds::get(cx)));
        }
        if self.disabled {
            button = button.disabled();
        }
        if let Some(handler) = self.on_click {
            button = button.on_click(move |event, window, cx| handler(event, window, cx));
        }
        button
    }
}

#[derive(IntoElement)]
pub struct SetupWizardStepCard {
    id: ElementId,
    title: SharedString,
    title_focus: Option<FocusHandle>,
    description: Option<SharedString>,
    progress: Option<AnyElement>,
    on_back: Option<Handler>,
    back_label: Option<SharedString>,
    content_key: Option<SharedString>,
    footer_start: Option<AnyElement>,
    actions: Vec<AnyElement>,
    children: Vec<AnyElement>,
}

impl SetupWizardStepCard {
    /// `title`: no glyph, so it starts on the content's left edge. `id` keys the card's window
    /// state (the first `content_key`).
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            title_focus: None,
            description: None,
            progress: None,
            on_back: None,
            back_label: None,
            content_key: None,
            footer_start: None,
            actions: Vec::new(),
            children: Vec::new(),
        }
    }

    /// Tracks the title heading (`titleId`, tabIndex -1): focus it when the step changes.
    pub fn title_focus(mut self, handle: FocusHandle) -> Self {
        self.title_focus = Some(handle);
        self
    }

    /// One line under the title.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The built `SetupWizardProgress` (`steps`, `activeIndex`, `progressLabel`), at the end of
    /// the header row.
    pub fn progress(mut self, progress: impl IntoElement) -> Self {
        self.progress = Some(progress.into_any_element());
        self
    }

    /// Shows the back action at the start of the header row.
    pub fn on_back(
        mut self,
        label: impl Into<SharedString>,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.back_label = Some(label.into());
        self.on_back = Some(Rc::new(handler));
        self
    }

    /// A new key fades in the title, body and footer; the header stays.
    pub fn content_key(mut self, key: impl Into<SharedString>) -> Self {
        self.content_key = Some(key.into());
        self
    }

    /// Status or a quiet link at the start of the footer row.
    pub fn footer_start(mut self, element: impl IntoElement) -> Self {
        self.footer_start = Some(element.into_any_element());
        self
    }

    /// `SetupWizardStepAction`s at the end of the footer row; the forward action comes last.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

impl ParentElement for SetupWizardStepCard {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl SetupWizardStepCard {
    /// Back sits on the step strip's first line (`.back`), also when a narrow card wraps it.
    fn header(&mut self, cx: &App) -> Option<AnyElement> {
        if self.on_back.is_none() && self.progress.is_none() {
            return None;
        }
        let ds = Ds::get(cx);
        let mut row = Stack::row()
            .justify(if self.on_back.is_some() {
                Justify::Between
            } else {
                Justify::End
            })
            .cross(Cross::Start)
            .gap(Space::Md);
        if let (Some(handler), Some(label)) = (self.on_back.take(), self.back_label.take()) {
            let back = Button::new((self.id.clone(), "back"))
                .variant(Variant::Inline)
                .size(Size::Sm)
                .icon_start(icon(Icon::ArrowLeft, IconSize::Md, ds))
                .text(label)
                .on_click(move |event, window, cx| handler(event, window, cx));
            row = row.child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .min_h(ds.len(Length::TypoCaptionLineHeight)) // DS: SetupWizardStepCard.module.css:3
                    .child(back),
            );
        }
        Some(row.children(self.progress.take()).into_any_element())
    }

    fn footer(&mut self) -> Option<AnyElement> {
        if self.footer_start.is_none() && self.actions.is_empty() {
            return None;
        }
        let mut row = Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Md)
            .child(
                Stack::new()
                    .grow()
                    .min_width(MinWidth::Zero)
                    .children(self.footer_start.take()),
            );
        if !self.actions.is_empty() {
            row = row.child(
                button::container(Size::Lg)
                    .justify(Justify::End)
                    .children(std::mem::take(&mut self.actions)),
            );
        }
        Some(row.into_any_element())
    }
}

impl RenderOnce for SetupWizardStepCard {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let first = window.use_keyed_state((self.id.clone(), "first-key"), cx, {
            let key = self.content_key.clone();
            move |_, _| key
        });
        let fade = self.content_key != *first.read(cx) && !Ds::get(cx).reduced_motion();
        let header = self.header(cx);
        let footer = self.footer();
        let mut heading = div().child(Typo::h4(self.title.clone()));
        if let Some(handle) = &self.title_focus {
            heading = heading.track_focus(handle);
        }
        let mut titles = Stack::new()
            .gap(Space::Xs)
            .min_width(MinWidth::Zero)
            .child(heading);
        if let Some(description) = self.description.take() {
            titles = titles.child(Typo::body(description).tone(Tone::Secondary));
        }
        let body = Stack::new()
            .gap(Space::Lg)
            .child(titles)
            .children(std::mem::take(&mut self.children))
            .children(footer);
        // The next step's content fades in over `--motion-base` decelerate (`.bodyEnter`).
        let body = if fade {
            let ds = Ds::get(cx);
            let timing = Timing::token(ds, Duration::MotionBase, Easing::MotionEaseDecelerate);
            let key = self.content_key.clone().unwrap_or_default();
            Tween::new(
                (self.id.clone(), key),
                div().child(body),
                timing,
                Styled::opacity,
            )
            .into_any_element()
        } else {
            body.into_any_element()
        };
        Stack::new().gap(Space::Lg).children(header).child(body)
    }
}
