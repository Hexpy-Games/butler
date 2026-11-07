//! DS ComposerDecisionPanel (ComposerDecisionPanel.tsx / .module.css): a pending decision shown in
//! place of the composer input: a subject row (icon, eyebrow, the title that opens its source, an
//! aside), optional detail lines, an error, a page thumbnail and the decision buttons. Number keys
//! focus an explicit decision; only Enter or a click runs it. A decision that leaves the panel
//! runs its exit first (`deferred`), then the caller's action.
mod details;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FocusHandle, IntoElement, ParentElement as _,
    RenderOnce, SharedString, Styled as _, Window, div, px,
};

pub use details::Detail;

use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::blocks::composer_panel::{self, FrameKeys, Placement, Subject};
use crate::ui::blocks::measure;
use crate::ui::button::{Button, Size, Variant};
use crate::ui::clickable::{Clickable, Variant as ClickVariant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

type Run = Rc<dyn Fn(&mut Window, &mut App)>;
type Open = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// One decision button: what it says and does. A `deferred` action runs after the panel's exit.
pub struct Action {
    label: SharedString,
    variant: Variant,
    icon: Option<Icon>,
    deferred: bool,
    run: Run,
}

impl Action {
    pub fn new(
        label: impl Into<SharedString>,
        variant: Variant,
        run: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            variant,
            icon: None,
            deferred: false,
            run: Rc::new(run),
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// Runs after the panel has left (`complete(action)`).
    pub fn deferred(mut self) -> Self {
        self.deferred = true;
        self
    }
}

/// The page thumbnail at the subject row's end.
pub struct Media {
    content: AnyElement,
    label: SharedString,
    on_open: Option<Open>,
}

impl Media {
    pub fn new(content: impl IntoElement, label: impl Into<SharedString>) -> Self {
        Self {
            content: content.into_any_element(),
            label: label.into(),
            on_open: None,
        }
    }

    pub fn on_open(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }
}

#[derive(IntoElement)]
pub struct ComposerDecisionPanel {
    id: ElementId,
    icon: Icon,
    eyebrow: Option<SharedString>,
    title: SharedString,
    on_open: Open,
    literal: bool,
    details: Vec<Detail>,
    labels: Option<(SharedString, SharedString)>,
    aside: Option<AnyElement>,
    error: Option<SharedString>,
    actions: Vec<Action>,
    extra: Vec<AnyElement>,
    media: Option<Media>,
    placement: Placement,
}

impl ComposerDecisionPanel {
    pub fn new(
        id: impl Into<ElementId>,
        icon: Icon,
        title: impl Into<SharedString>,
        on_open: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            icon,
            eyebrow: None,
            title: title.into(),
            on_open: Rc::new(on_open),
            literal: false,
            details: Vec::new(),
            labels: None,
            aside: None,
            error: None,
            actions: Vec::new(),
            extra: Vec::new(),
            media: None,
            placement: Placement::Composer,
        }
    }

    /// The localized decision category above the title.
    pub fn eyebrow(mut self, eyebrow: impl Into<SharedString>) -> Self {
        self.eyebrow = Some(eyebrow.into());
        self
    }

    /// The title and details are the exact action: drawn as their own characters.
    pub fn literal(mut self) -> Self {
        self.literal = true;
        self
    }

    pub fn details(mut self, details: impl IntoIterator<Item = Detail>) -> Self {
        self.details = details.into_iter().collect();
        self
    }

    /// Clamps long details to four lines behind an inline "Show more".
    pub fn details_labels(
        mut self,
        show_more: impl Into<SharedString>,
        show_less: impl Into<SharedString>,
    ) -> Self {
        self.labels = Some((show_more.into(), show_less.into()));
        self
    }

    /// Trailing subject-row content (a status Tag, a count).
    pub fn aside(mut self, aside: impl IntoElement) -> Self {
        self.aside = Some(aside.into_any_element());
        self
    }

    /// A failed decision, announced between the subject and the actions.
    pub fn error(mut self, error: impl Into<SharedString>) -> Self {
        self.error = Some(error.into());
        self
    }

    pub fn action(mut self, action: Action) -> Self {
        self.actions.push(action);
        self
    }

    /// An action that is not a plain button (a SplitButton), after the buttons.
    pub fn custom_action(mut self, element: impl IntoElement) -> Self {
        self.extra.push(element.into_any_element());
        self
    }

    pub fn media(mut self, media: Media) -> Self {
        self.media = Some(media);
        self
    }

    pub fn placement(mut self, placement: Placement) -> Self {
        self.placement = placement;
        self
    }
}

/// What the number keys and Enter act on: the plain buttons, in order.
struct Choice {
    focus: FocusHandle,
    run: Run,
    deferred: bool,
}

impl ComposerDecisionPanel {
    fn buttons(
        &mut self,
        pending: &gpui::Entity<Option<Run>>,
        window: &mut Window,
        cx: &mut App,
    ) -> (Vec<AnyElement>, Vec<Rc<Choice>>) {
        let mut elements = Vec::new();
        let mut choices = Vec::new();
        for (index, action) in std::mem::take(&mut self.actions).into_iter().enumerate() {
            let key: SharedString = format!("action-{index}").into();
            let focus = window
                .use_keyed_state((self.id.clone(), key.clone()), cx, |_, cx| {
                    cx.focus_handle()
                })
                .read(cx)
                .clone();
            let ds = Ds::get(cx);
            let mut button = Button::new((self.id.clone(), key))
                .size(Size::Sm)
                .variant(action.variant)
                .text(action.label);
            if let Some(glyph) = action.icon {
                button = button.icon_start(icon(glyph, IconSize::Sm, ds));
            }
            let mut control = button.control(ds);
            control.radius = self.placement.button_radius(ds);
            control.focus = Some(focus.clone());
            let choice = Rc::new(Choice {
                focus,
                run: action.run,
                deferred: action.deferred,
            });
            let (go, state) = (choice.clone(), pending.clone());
            control.on_click(Some(Rc::new(move |_, window, cx| {
                begin(&go, &state, window, cx);
            })));
            elements.push(control.into_any_element());
            choices.push(choice);
        }
        (elements, choices)
    }
}

impl ComposerDecisionPanel {
    /// The scrolling details body, when there are details.
    fn details_body(
        &mut self,
        placement: Placement,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        (!self.details.is_empty()).then(|| {
            let labels = self
                .labels
                .take()
                .map(|(more, less)| details::Labels { more, less });
            let lines = details::details(
                &self.id,
                &self.details,
                self.literal,
                labels.as_ref(),
                window,
                cx,
            );
            composer_panel::body(
                (self.id.clone(), "details-scroll"),
                true,
                lines,
                placement,
                Ds::get(cx),
            )
        })
    }

    /// The title, a text-variant click target that opens the subject.
    fn title_link(&self) -> Clickable {
        Clickable::new((self.id.clone(), "title"))
            .variant(ClickVariant::Text)
            .on_click({
                let open = self.on_open.clone();
                move |event, window, cx| open(event, window, cx)
            })
            .child({
                let label = Typo::label(self.title.clone())
                    .weight(Weight::Medium)
                    .tone(Tone::Primary)
                    .wrap(Wrap::Anywhere);
                if self.literal { label.literal() } else { label }
            })
    }
}

/// A decision was made: a deferred one waits for the exit, the rest run now.
fn begin(choice: &Choice, pending: &gpui::Entity<Option<Run>>, window: &mut Window, cx: &mut App) {
    if choice.deferred {
        let run = choice.run.clone();
        pending.update(cx, |pending, cx| {
            if pending.is_none() {
                *pending = Some(run);
            }
            cx.notify();
        });
    } else {
        (choice.run)(window, cx);
    }
}

impl RenderOnce for ComposerDecisionPanel {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let pending = window.use_keyed_state((self.id.clone(), "pending"), cx, |_, _| None::<Run>);
        let leaving =
            composer_panel::exit_progress(self.id.clone(), pending.read(cx).is_some(), window, cx);
        if leaving >= 0.999
            && let Some(run) = pending.update(cx, |pending, _| pending.take())
        {
            window.defer(cx, move |window, cx| run(window, cx));
        }
        let (buttons, choices) = self.buttons(&pending, window, cx);
        let (seen, recorder) = measure::track((self.id.clone(), "panel"), window, cx);
        let width = f32::from(seen.width);
        let placement = self.placement;
        let details = self.details_body(placement, window, cx);
        let ds = Ds::get(cx);
        let title = self.title_link();
        let subject = composer_panel::header(
            Subject {
                icon: icon(self.icon, IconSize::Sm, ds).into_any_element(),
                eyebrow: self.eyebrow.clone(),
                title: title.into_any_element(),
                aside: self.aside.take(),
                tabbed: false,
                has_body: details.is_some() || self.media.is_some() || self.error.is_some(),
            },
            placement,
            ds,
        );
        let inset = placement.inset(ds);
        let error = self.error.take().map(|text| {
            div()
                .py(ds.len(Length::SpaceSm))
                .px(inset)
                .pl(inset + ds.len(Length::IconSizeSm) + ds.len(Length::SpaceSm))
                .text_color(ds.color(Color::ColorDangerText))
                .child(Typo::caption(text).tone(Tone::Inherit))
        });
        let media = self.media.take();
        let text_column = div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(subject)
            .children(details);
        let top = match media {
            Some(media) => media_layout(text_column, media, width, placement, &self.id, ds),
            None => text_column.into_any_element(),
        };
        let actions = composer_panel::actions(
            buttons.into_iter().chain(self.extra).collect(),
            placement,
            ds,
        );
        let content = div()
            .relative()
            .flex()
            .flex_col()
            .min_w_0()
            .child(recorder)
            .child(top)
            .children(error)
            .child(actions)
            .into_any_element();
        let keys = FrameKeys {
            id: self.id,
            on_key: Rc::new(move |event, own, window, cx| {
                key_down(event, own, &choices, &pending, window, cx);
            }),
        };
        composer_panel::frame(placement, keys, leaving, content, window, cx)
    }
}

/// `composerDecisionKeyboard`: Escape stays with the decision; 1 to 9 focus the nth button;
/// Enter on the panel itself runs the last one.
fn key_down(
    event: &gpui::KeyDownEvent,
    own: bool,
    choices: &[Rc<Choice>],
    pending: &gpui::Entity<Option<Run>>,
    window: &mut Window,
    cx: &mut App,
) {
    let modifiers = event.keystroke.modifiers;
    if event.is_held || modifiers.alt || modifiers.control || modifiers.platform {
        return;
    }
    let key = event.keystroke.key.as_str();
    if key == "escape" {
        cx.stop_propagation();
        return;
    }
    if let Some(n) = key
        .parse::<usize>()
        .ok()
        .filter(|n| (1..=9).contains(n) && *n <= choices.len())
    {
        cx.stop_propagation();
        choices[n - 1].focus.focus(window, cx);
    } else if key == "enter"
        && own
        && let Some(last) = choices.last()
    {
        cx.stop_propagation();
        begin(last, pending, window, cx);
    }
}

/// A page thumbnail beside the subject (144px, 112px under 600px), or under the details in the
/// text column of a composer under 420px, cropped to `--decision-media-narrow-height`.
fn media_layout(
    text: gpui::Div,
    media: Media,
    width: f32,
    placement: Placement,
    id: &ElementId,
    ds: &Ds,
) -> AnyElement {
    let inset = placement.inset(ds);
    let narrow = width > 0. && width < 420.; // DS: ComposerDecisionPanel.module.css:123
    let side = if width > 0. && width < 600. {
        112.
    } else {
        144.
    }; // DS: ComposerDecisionPanel.module.css:111
    let target = div()
        .overflow_hidden()
        .rounded(ds.len(Length::RadiusControl))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(media.content);
    let target = match media.on_open {
        Some(open) => Clickable::new((id.clone(), "media"))
            .variant(ClickVariant::Text)
            .on_click(move |event, window, cx| open(event, window, cx))
            .child(target)
            .into_any_element(),
        None => target.into_any_element(),
    };
    let _ = media.label;
    if narrow {
        let start = inset + ds.len(Length::IconSizeSm) + ds.len(Length::SpaceSm);
        div()
            .flex()
            .flex_col()
            .child(text)
            .child(
                div()
                    .pl(start)
                    .pr(inset)
                    .pb(ds.len(Length::SpaceMd))
                    .max_h(px(140.)) // DS: tokens.css --decision-media-narrow-height
                    .child(target),
            )
            .into_any_element()
    } else {
        div()
            .flex()
            .items_start()
            .child(div().flex_1().min_w_0().child(text))
            .child(
                div()
                    .flex_none()
                    .w(px(side) + inset)
                    .pt(inset)
                    .pr(inset)
                    .pb(ds.len(Length::SpaceSm))
                    .child(target),
            )
            .into_any_element()
    }
}
