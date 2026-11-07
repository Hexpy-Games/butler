//! The panel's tabs, action row and keyboard handling.
use std::rc::Rc;

use gpui::{
    AnyElement, App, IntoElement as _, KeyDownEvent, ParentElement as _, Styled as _, Window, div,
};

use super::model::{Ctx, Model, QuestionKind, answer_text};
use super::{PanelState, View, leave_then};
use crate::tokens::Length;
use crate::ui::blocks::composer_panel;
use crate::ui::button::{Button, Size, Variant};
use crate::ui::context::Ds;
use crate::ui::spinner::Spinner;
use crate::ui::tabs::{ListVariant, Tabs, TabsList, Trigger};
use crate::ui::typo::{Tone, Typo};

/// The key handler the frame installs on the panel.
pub(super) type KeyHandler = Rc<dyn Fn(&KeyDownEvent, bool, &mut Window, &mut App)>;

impl View<'_> {
    /// The tab row (one tab per question, then the review) over the current step's panel.
    pub(super) fn tabbed(&self, step: usize, panel: gpui::Div, ds: &Ds) -> AnyElement {
        let triggers = self
            .ctx
            .questions
            .iter()
            .enumerate()
            .map(|(index, question)| (index.to_string(), question.header.clone()))
            .chain([(
                self.ctx.questions.len().to_string(),
                self.labels.review.clone(),
            )])
            .map(|(value, label)| {
                let trigger = Trigger::new(value, label);
                if self.ctx.busy {
                    trigger.disabled()
                } else {
                    trigger
                }
            });
        let list = TabsList::new(self.labels.select.clone())
            .variant(ListVariant::Line)
            .triggers(triggers);
        let (model, ctx) = (self.model.clone(), self.ctx.clone());
        // `.tabInset`: the list sits in the panel's inset, `--space-sm` below the top edge.
        let tabs = Tabs::new((self.id.clone(), "tabs"))
            .value(step.to_string())
            .on_value_change(move |value, _, cx| {
                if let Ok(index) = value.parse::<usize>() {
                    model.update(cx, |model, cx| {
                        model.go(index, &ctx, cx);
                        cx.notify();
                    });
                }
            })
            .list(list);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .min_w_0()
                    .pt(ds.len(Length::SpaceSm))
                    .px(self.placement.inset(ds))
                    .child(tabs),
            )
            .child(panel)
            .into_any_element()
    }

    pub(super) fn actions(&self, snapshot: &Model, ds: &Ds) -> AnyElement {
        let questions = &self.ctx.questions;
        let many = questions.len() > 1;
        let review = snapshot.review(&self.ctx);
        let step = snapshot.step;
        let can_send = review
            || questions.get(step).is_some_and(|question| {
                !answer_text(question, snapshot.answers.get(step)).is_empty()
            });
        let immediate = !many
            && questions
                .first()
                .is_some_and(|question| question.kind == QuestionKind::Single)
            && !snapshot.other_open
            && snapshot
                .answers
                .first()
                .is_some_and(|answer| answer.other.is_empty());
        let busy = self.ctx.busy;
        let mut buttons: Vec<AnyElement> = Vec::new();
        if many {
            let (model, ctx) = (self.model.clone(), self.ctx.clone());
            let mut back = Button::new((self.id.clone(), "back"))
                .size(Size::Sm)
                .variant(Variant::Borderless)
                .text(self.labels.back.clone())
                .on_click(move |_, _, cx| {
                    model.update(cx, |model, cx| {
                        model.go(model.step.saturating_sub(1), &ctx, cx);
                        cx.notify();
                    });
                });
            if busy || step == 0 {
                back = back.disabled();
            }
            buttons.push(back.into_any_element());
        }
        if !review {
            buttons.push(self.skip_button(many, busy).into_any_element());
        }
        if !immediate || busy {
            let (model, ctx) = (self.model.clone(), self.ctx.clone());
            let label = if many && !review {
                self.labels.next.clone()
            } else {
                self.labels.send.clone()
            };
            let mut next = Button::new((self.id.clone(), "next"))
                .size(Size::Sm)
                .text(label)
                .on_click(move |_, window, cx| {
                    model.update(cx, |model, cx| {
                        if review {
                            model.send(&ctx, window, cx);
                        } else {
                            model.advance(&ctx, window, cx);
                        }
                        cx.notify();
                    });
                });
            if self.state == PanelState::Submitting {
                next = next.icon_start(Spinner::new((self.id.clone(), "submitting")).size(14.));
            }
            if busy || !can_send {
                next = next.disabled();
            }
            buttons.push(next.into_any_element());
        }
        let working = (self.state == PanelState::Working).then(|| {
            div()
                .mr_auto()
                .child(Typo::caption(self.labels.working.clone()).tone(Tone::Tertiary))
                .into_any_element()
        });
        let row = working.into_iter().chain(buttons).collect();
        composer_panel::actions(row, self.placement, ds)
    }

    /// Skip: one question reports it; several record a skipped answer and move on.
    fn skip_button(&self, many: bool, busy: bool) -> Button {
        let (model, ctx) = (self.model.clone(), self.ctx.clone());
        let mut skip = Button::new((self.id.clone(), "skip"))
            .size(Size::Sm)
            .variant(Variant::Secondary)
            .text(self.labels.skip.clone())
            .on_click(move |_, window, cx| {
                if !many {
                    (ctx.callbacks.skip)(window, cx);
                    return;
                }
                model.update(cx, |model, cx| {
                    model.update(
                        |answer| {
                            answer.selected.clear();
                            answer.text.clear();
                            answer.other.clear();
                            answer.skipped = true;
                        },
                        &ctx,
                        cx,
                    );
                    model.go(model.step + 1, &ctx, cx);
                    cx.notify();
                });
            });
        if busy {
            skip = skip.disabled();
        }
        skip
    }

    /// `useQuestionPanel.keyDown`: Escape collapses, arrows move between questions and options,
    /// digits choose, Space toggles a multiple choice, Enter chooses or advances.
    pub(super) fn key_handler(&self) -> KeyHandler {
        let (model, ctx, leave) = (self.model.clone(), self.ctx.clone(), self.leave.clone());
        let run = self.ctx.callbacks.collapse.clone();
        Rc::new(move |event, _own, window, cx| {
            let modifiers = event.keystroke.modifiers;
            if ctx.busy || event.is_held || modifiers.alt || modifiers.control || modifiers.platform
            {
                return;
            }
            let key = event.keystroke.key.as_str();
            if key == "escape" {
                cx.stop_propagation();
                leave_then(&leave, &run, cx);
                return;
            }
            model.update(cx, |model, cx| {
                if navigate(model, key, &ctx, window, cx) {
                    cx.stop_propagation();
                    cx.notify();
                }
            });
        })
    }
}

/// One key on the panel itself; whether it was ours.
fn navigate(model: &mut Model, key: &str, ctx: &Ctx, window: &mut Window, cx: &mut App) -> bool {
    let many = ctx.questions.len() > 1;
    if many && matches!(key, "left" | "right") {
        let next = if key == "right" {
            model.step + 1
        } else {
            model.step.saturating_sub(1)
        };
        model.go(next, ctx, cx);
        return true;
    }
    if model.review(ctx) {
        if key == "enter" {
            model.send(ctx, window, cx);
            return true;
        }
        return false;
    }
    let question = &ctx.questions[model.step];
    if question.kind == QuestionKind::Text {
        return false;
    }
    let last = question.options.len() + usize::from(question.allow_other);
    if let Some(n) = key
        .parse::<usize>()
        .ok()
        .filter(|n| (1..=9).contains(n) && *n <= last)
    {
        model.choose(n - 1, ctx, window, cx);
        return true;
    }
    match key {
        "down" | "up" => {
            let delta = if key == "down" { 1 } else { -1 };
            model.highlight = model.highlight.saturating_add_signed(delta).min(last - 1);
            true
        }
        "space" if question.kind == QuestionKind::Multi => {
            model.choose(model.highlight, ctx, window, cx);
            true
        }
        "enter" if question.kind == QuestionKind::Single => {
            model.choose(model.highlight, ctx, window, cx);
            true
        }
        "enter" => {
            if !answer_text(question, model.answers.get(model.step)).is_empty() {
                model.advance(ctx, window, cx);
            }
            true
        }
        _ => false,
    }
}
