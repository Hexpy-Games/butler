//! `CanonPlanSelect.tsx`, `CanonFormFields.tsx` and `CanonFormFooter.tsx`.
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use butler_ds::ui::text::{Input, Textarea};
use butler_ds::ui::tooltip::Tooltip;
use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement as _, ParentElement as _, SharedString, Window,
};
use gpui_elements::editable_text::EditableTextState;

use super::copy::words;
use super::{OnSelect, SelectOpts};
use crate::ui::manage::Action;
use crate::ui::source::wire::CanonPlan;

/// `maxLength` of the title input.
const TITLE_MAX: usize = 120;

/// The select's size, width and disabled state from `compact`, `stretch` and `disabled`.
pub(super) fn styled(select: NativeSelect, opts: SelectOpts) -> NativeSelect {
    let select = select.size(if opts.compact {
        SelectSize::Sm
    } else {
        SelectSize::Default
    });
    let select = if opts.stretch {
        select.stretch()
    } else {
        select
    };
    if opts.disabled {
        select.disabled()
    } else {
        select
    }
}

/// `CanonPlanSelect`: the backlog (no plan) first, then the plans.
pub(crate) fn plan_select(
    id: impl Into<ElementId>,
    plans: &[CanonPlan],
    value: Option<SharedString>,
    opts: SelectOpts,
    on_change: OnSelect,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut select = NativeSelect::new(id)
        .value(value.unwrap_or_else(|| "backlog".into()))
        .option("backlog", words(Ds::get(cx).lang()).backlog);
    for plan in plans {
        select = select.option(plan.id.clone(), plan.title.clone());
    }
    styled(select, opts)
        .on_change(move |picked, window, cx| {
            let plan = (picked != "backlog").then(|| SharedString::from(picked.to_owned()));
            on_change(plan, window, cx);
        })
        .into_any_element()
}

/// `CanonFormFields`. `title` and `description` are the editor states of the fields
/// `{prefix}-title` and `{prefix}-description` (`text::state`), which this draws; the title is
/// kept to its `maxLength`. The dialog around the fields focuses the title (the first tab stop).
pub(crate) fn form_fields(
    prefix: &str,
    title: &Entity<EditableTextState>,
    _description: &Entity<EditableTextState>,
    attachment: Option<AnyElement>,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = words(Ds::get(cx).lang());
    let state = title.clone();
    let title_input = Input::new(SharedString::from(format!("{prefix}-title")))
        .placeholder(copy.title_placeholder)
        .on_change(move |text, _, cx| {
            if text.chars().count() > TITLE_MAX {
                let kept: String = text.chars().take(TITLE_MAX).collect();
                state.update(cx, |state, cx| state.emplace(&kept, cx));
            }
        });
    let description_input = Textarea::new(SharedString::from(format!("{prefix}-description")))
        .placeholder(copy.description_placeholder);
    Stack::new()
        .gap(Space::Md)
        .child(
            Field::new(SharedString::from(format!("{prefix}-title-field")))
                .child(FieldLabel::new().child(copy.title))
                .child(title_input),
        )
        .child(
            Field::new(SharedString::from(format!("{prefix}-description-field")))
                .child(FieldLabel::new().child(format!("{} · {}", copy.description, copy.optional)))
                .child(description_input)
                .children(attachment),
        )
        .into_any_element()
}

/// `CanonFormFooter`, with the submit button's action. React's button is `type="submit"` of the
/// form around it; the DS dialog form has no submit event, so the owner passes it here.
pub(crate) fn form_footer_submit(
    title: &str,
    busy: bool,
    submit: SharedString,
    on_cancel: Action,
    on_submit: Action,
    cx: &App,
) -> AnyElement {
    let copy = words(Ds::get(cx).lang());
    let blank = title.trim().is_empty();
    let mut cancel = Button::new("canon-form-cancel")
        .size(Size::Sm)
        .variant(Variant::Ghost)
        .text(copy.cancel)
        .on_click(move |_, window, cx| on_cancel(window, cx));
    let mut send = Button::new("canon-form-submit")
        .size(Size::Sm)
        .text(submit)
        .on_click(move |_, window, cx| {
            if !busy && !blank {
                on_submit(window, cx);
            }
        });
    if busy {
        cancel = cancel.disabled();
        send = send.disabled();
    } else if blank {
        send = send.aria_disabled();
    }
    let send = if blank {
        Tooltip::new("canon-form-submit-tip")
            .label(copy.title_required)
            .child(send)
            .into_any_element()
    } else {
        send.into_any_element()
    };
    button::container(Size::Sm)
        .justify(Justify::End)
        .child(cancel)
        .child(send)
        .into_any_element()
}
