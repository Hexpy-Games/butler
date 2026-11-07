//! QuestionOptions.tsx: the option rows of one question, the text field of a text question and
//! the review rows.
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div,
};

use super::model::{Ctx, Labels, Model, Question, QuestionKind, answer_text};
use crate::tokens::Length;
use crate::ui::Icon;
use crate::ui::clickable::Clickable;
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use crate::ui::tag::{Tag, Tone as TagTone};
use crate::ui::text::{Input, InputVariant, TextSize};
use crate::ui::typo::{Tone, Typo, Wrap};

/// What the rows read of the panel.
pub(super) struct Rows<'a> {
    pub id: &'a gpui::ElementId,
    pub ctx: &'a Ctx,
    pub labels: &'a Labels,
    pub model: &'a Entity<Model>,
    pub step: usize,
    pub snapshot: &'a Model,
}

/// `min-height: max(var(--menu-item-height), var(--control-hit-target))`.
fn row_height(ds: &Ds) -> gpui::Pixels {
    ds.menu_item_height().max(ds.len(Length::ControlHitTarget))
}

fn mutate(
    model: &Entity<Model>,
    ctx: &Ctx,
    cx: &mut App,
    change: impl FnOnce(&mut Model, &Ctx, &mut gpui::Context<Model>),
) {
    model.update(cx, |model, cx| {
        change(model, ctx, cx);
        cx.notify();
    });
}

/// A text question: one field.
fn text_field(rows: &Rows, question: &Question) -> AnyElement {
    let (model, ctx) = (rows.model.clone(), rows.ctx.clone());
    let placeholder = question
        .placeholder
        .clone()
        .unwrap_or_else(|| rows.labels.other.clone());
    let key: SharedString = format!("text-{}", question.id).into();
    let mut input = Input::new((rows.id.clone(), key))
        .placeholder(placeholder)
        .default_value(rows.snapshot.answers[rows.step].text.clone())
        .on_change(move |text, _, cx| {
            let text = text.to_owned();
            mutate(&model, &ctx, cx, move |model, ctx, cx| {
                model.update(
                    |answer| {
                        answer.text = text;
                        answer.skipped = false;
                    },
                    ctx,
                    cx,
                );
            });
        });
    if rows.ctx.busy {
        input = input.disabled();
    }
    input.into_any_element()
}

fn trailing(question: &Question, index: usize, selected: bool, ds: &Ds) -> Option<AnyElement> {
    let glyph = if index == question.options.len() {
        Icon::Pencil
    } else if question.kind == QuestionKind::Multi {
        if selected {
            Icon::CheckCircle2
        } else {
            Icon::Square
        }
    } else if selected {
        Icon::CheckIcon
    } else {
        return None;
    };
    Some(icon(glyph, IconSize::Md, ds).into_any_element())
}

/// The content of one row: the number, the label (with the recommended tag) over the
/// description, and the trailing mark.
fn row_content(
    rows: &Rows,
    question: &Question,
    index: usize,
    editing: bool,
    selected: bool,
    ds: &Ds,
) -> AnyElement {
    let other = index == question.options.len();
    let option = question.options.get(index);
    let label: AnyElement = if editing {
        let (model, ctx) = (rows.model.clone(), rows.ctx.clone());
        let key: SharedString = format!("other-{}", question.id).into();
        let placeholder = question
            .placeholder
            .clone()
            .unwrap_or_else(|| rows.labels.other.clone());
        let mut input = Input::new((rows.id.clone(), key))
            .variant(InputVariant::Underline)
            .text_size(TextSize::Label)
            .placeholder(placeholder)
            .default_value(rows.snapshot.answers[rows.step].other.clone())
            .on_change(move |text, _, cx| {
                let text = text.to_owned();
                mutate(&model, &ctx, cx, move |model, ctx, cx| {
                    model.update(
                        |answer| {
                            answer.other = text;
                            answer.skipped = false;
                        },
                        ctx,
                        cx,
                    );
                });
            });
        if rows.ctx.busy {
            input = input.disabled();
        }
        div().min_w_0().flex_1().child(input).into_any_element()
    } else {
        let typed = &rows.snapshot.answers[rows.step].other;
        let text = match option {
            Some(option) => option.label.clone(),
            None if !typed.is_empty() => typed.clone().into(),
            None => rows.labels.other.clone(),
        };
        let label = Typo::label(text);
        let label = if other {
            label.truncate()
        } else {
            label.wrap(Wrap::Anywhere)
        };
        div().min_w_0().child(label).into_any_element()
    };
    let tag = option.filter(|option| option.recommended).map(|_| {
        Tag::new(
            (rows.id.clone(), "recommended"),
            rows.labels.recommended.clone(),
        )
        .tone(TagTone::Accent)
    });
    let description = option
        .and_then(|option| option.description.clone())
        .map(|text| {
            Typo::caption(text)
                .tone(Tone::Secondary)
                .wrap(Wrap::Anywhere)
        });
    div()
        .flex()
        .items_start()
        .w_full()
        .child(
            IconSlot::new()
                .size(SlotSize::Lg)
                .min_line()
                .tone(SlotTone::Tertiary)
                .child(Typo::caption(format!("{}", index + 1)).tone(Tone::Tertiary)),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .gap(ds.len(Length::SpaceXs))
                        .child(label)
                        .children(tag),
                )
                .children(description),
        )
        .child(
            IconSlot::new()
                .min_line()
                .tone(SlotTone::Secondary)
                .children(trailing(question, index, selected, ds)),
        )
        .into_any_element()
}

/// The option rows of the current question.
pub(super) fn options(
    rows: &Rows,
    question: &Question,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = window;
    if question.kind == QuestionKind::Text {
        return text_field(rows, question);
    }
    let ds = Ds::get(cx);
    let count = question.options.len() + usize::from(question.allow_other);
    let answer = &rows.snapshot.answers[rows.step];
    let mut stack = div().flex().flex_col().gap(ds.len(Length::SpaceXs));
    for index in 0..count {
        let other = index == question.options.len();
        let selected = if other {
            !answer.other.trim().is_empty()
        } else {
            answer.selected.contains(&index)
        };
        let editing = other && rows.snapshot.other_open;
        let content = row_content(rows, question, index, editing, selected, ds);
        let highlighted = rows.snapshot.highlight == index;
        let height = row_height(ds);
        let pad = ds.len(Length::MenuItemPaddingBlock);
        if editing {
            stack = stack.child(
                div()
                    .flex()
                    .items_center()
                    .min_h(height)
                    .px(ds.len(Length::SpaceSm))
                    .py(pad)
                    .rounded(ds.len(Length::RadiusControl))
                    .bg(ds.color(crate::tokens::Color::Selection))
                    .child(content),
            );
            continue;
        }
        let (model, ctx) = (rows.model.clone(), rows.ctx.clone());
        let mut row = Clickable::new((
            rows.id.clone(),
            SharedString::from(format!("option-{index}")),
        ))
        .stretch()
        .metrics(ds.len(Length::SpaceSm), height)
        .fills(
            ds.color(crate::tokens::Color::Selection),
            ds.color(crate::tokens::Color::Selection),
        )
        .selected(highlighted || selected)
        .on_click(move |_, window, cx| {
            mutate(&model, &ctx, cx, |model, ctx, cx| {
                model.choose(index, ctx, window, cx)
            });
        });
        if rows.ctx.busy {
            row = row.disabled();
        }
        stack = stack.child(row.child(div().py(pad).child(content)));
    }
    stack.into_any_element()
}

/// The review: one row per question with its answer, a pencil to go back to it.
pub(super) fn review(rows: &Rows, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let mut stack = div().flex().flex_col().gap(ds.len(Length::SpaceXs));
    for (index, question) in rows.ctx.questions.iter().enumerate() {
        let text = answer_text(question, rows.snapshot.answers.get(index));
        let text = if text.is_empty() {
            rows.labels.skipped.to_string()
        } else {
            text
        };
        let (model, ctx) = (rows.model.clone(), rows.ctx.clone());
        let mut row = Clickable::new((
            rows.id.clone(),
            SharedString::from(format!("review-{index}")),
        ))
        .stretch()
        .metrics(ds.len(Length::SpaceSm), row_height(ds))
        .on_click(move |_, _, cx| {
            mutate(&model, &ctx, cx, |model, ctx, cx| model.go(index, ctx, cx))
        });
        if rows.ctx.busy {
            row = row.disabled();
        }
        stack = stack.child(
            row.child(
                div()
                    .flex()
                    .items_start()
                    .w_full()
                    .py(ds.len(Length::MenuItemPaddingBlock))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(Typo::caption(question.header.clone()).tone(Tone::Tertiary))
                            .child(Typo::label(text).wrap(Wrap::Anywhere)),
                    )
                    .child(
                        IconSlot::new()
                            .min_line()
                            .tone(SlotTone::Tertiary)
                            .child(icon(Icon::Pencil, IconSize::Md, ds)),
                    ),
            ),
        );
    }
    stack.into_any_element()
}
