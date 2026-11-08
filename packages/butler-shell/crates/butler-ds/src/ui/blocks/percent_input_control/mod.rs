//! DS PercentInputControl (PercentInputControl.tsx): a percentage setting as a number input, a
//! slider and a live `n%` caption. It owns the commit rules: a typed value is rounded and kept in
//! `min..=max`, an unchanged value is not committed, and a commit the owner refuses (`on_commit`
//! returns `false`) rolls the control back to `value`.
pub(crate) mod shell;

use std::rc::Rc;

use gpui::{App, ElementId, IntoElement, RenderOnce, Window};

use self::shell::{Commit, Draft, View, draft, set_text, show, view};

type Handler = Rc<dyn Fn(f64, &mut Window, &mut App) -> bool>;

#[derive(IntoElement)]
pub struct PercentInputControl {
    id: ElementId,
    value: f64,
    min: f64,
    max: f64,
    step: f64,
    disabled: bool,
    on_commit: Option<Handler>,
}

impl PercentInputControl {
    /// `id` names the control; `value` is the committed percentage.
    pub fn new(id: impl Into<ElementId>, value: f64) -> Self {
        Self {
            id: id.into(),
            value,
            min: 0.,
            max: 100.,
            step: 5., // DS: PercentInputControl.tsx:46
            disabled: false,
            on_commit: None,
        }
    }

    pub fn min(mut self, min: f64) -> Self {
        self.min = min;
        self
    }

    pub fn max(mut self, max: f64) -> Self {
        self.max = max;
        self
    }

    /// The slider step; typed values keep whole-percent precision.
    pub fn step(mut self, step: f64) -> Self {
        self.step = step;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// `onCommit`: called when a changed value is committed (blur, Enter or the end of a slider
    /// drag). Return `false` to roll the control back to `value`.
    pub fn on_commit(
        mut self,
        handler: impl Fn(f64, &mut Window, &mut App) -> bool + 'static,
    ) -> Self {
        self.on_commit = Some(Rc::new(handler));
        self
    }
}

/// `Math.round`: halves go up.
fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// A typed percentage kept in range; `Number("")` is 0 and anything unreadable is `min`.
fn parse(raw: &str, min: f64, max: f64) -> f64 {
    let trimmed = raw.trim();
    let parsed = if trimmed.is_empty() {
        Some(0.)
    } else {
        trimmed
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
    };
    parsed.map_or(min, |value| round(value).clamp(min, max))
}

/// The text to show, and the value to commit (`None` when nothing changed).
fn resolve(raw: &str, committed: f64, min: f64, max: f64) -> (gpui::SharedString, Option<f64>) {
    let next = parse(raw, min, max);
    let changed = (next - committed).abs() > f64::EPSILON;
    (show(next), changed.then_some(next))
}

impl RenderOnce for PercentInputControl {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let draft = draft(&self.id, self.value, window, cx);
        let slider_value = parse(&draft.text.read(cx).clone(), self.min, self.max);
        let (value, min, max) = (self.value, self.min, self.max);
        let on_commit = self.on_commit;
        let commit: Commit = Rc::new(
            move |raw: &str, draft: &Draft, window: &mut Window, cx: &mut App| {
                let committed = *draft.committed.read(cx);
                let (text, next) = resolve(raw, committed, min, max);
                set_text(&draft.text, text, cx);
                let Some(next) = next else { return };
                draft.committed.update(cx, |committed, _| *committed = next);
                let kept = on_commit
                    .as_ref()
                    .is_none_or(|on_commit| on_commit(next, window, cx));
                if !kept {
                    draft
                        .committed
                        .update(cx, |committed, _| *committed = value);
                    set_text(&draft.text, show(value), cx);
                }
            },
        );
        view(
            View {
                id: self.id,
                min: self.min,
                max: self.max,
                step: self.step,
                disabled: self.disabled,
                slider_value,
                caption: format!("{slider_value:.0}%"),
            },
            &draft,
            commit,
            window,
            cx,
        )
    }
}
