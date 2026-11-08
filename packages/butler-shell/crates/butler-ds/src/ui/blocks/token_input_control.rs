//! DS TokenInputControl (TokenInputControl.tsx): a token budget as a number input, a slider and
//! a `value / max` caption. A typed budget may carry commas, underscores and spaces; it is cut
//! to a whole number and kept in `min..=max`, and `on_commit` learns whether it was clamped.
use std::rc::Rc;

use gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window};

use super::percent_input_control::shell::{Commit, Draft, View, draft, set_text, show, view};

type Handler = Rc<dyn Fn(f64, bool, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct TokenInputControl {
    id: ElementId,
    value: f64,
    min: f64,
    max: f64,
    step: f64,
    disabled: bool,
    on_commit: Option<Handler>,
}

impl TokenInputControl {
    /// `id` names the control; `value` is the committed budget, kept within `min..=max`.
    pub fn new(id: impl Into<ElementId>, value: f64, min: f64, max: f64) -> Self {
        Self {
            id: id.into(),
            value,
            min,
            max,
            step: 1000., // DS: TokenInputControl.tsx:45
            disabled: false,
            on_commit: None,
        }
    }

    /// The slider step in tokens.
    pub fn step(mut self, step: f64) -> Self {
        self.step = step;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// `onCommit(value, clamped)`: `clamped` is true when the typed value was out of range.
    pub fn on_commit(
        mut self,
        handler: impl Fn(f64, bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_commit = Some(Rc::new(handler));
        self
    }
}

/// A typed budget (commas, underscores and spaces allowed) cut to a whole number. `None` when it
/// is unreadable or zero.
fn parse(raw: &str) -> Option<f64> {
    let digits: String = raw
        .chars()
        .filter(|c| !matches!(c, ',' | '_') && !c.is_whitespace())
        .collect();
    let value = digits
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())?
        .trunc();
    (value.abs() >= 1.).then_some(value) // DS: TokenInputControl.tsx:28 (`!parsed`)
}

/// The text to show, and the `(value, clamped)` to commit; an unusable text restores `committed`.
fn resolve(raw: &str, committed: f64, min: f64, max: f64) -> (SharedString, Option<(f64, bool)>) {
    let Some(parsed) = parse(raw) else {
        return (show(committed), None);
    };
    let value = parsed.clamp(min, max);
    (
        show(value),
        Some((value, (value - parsed).abs() > f64::EPSILON)),
    )
}

/// `n.toLocaleString("en-US")`: groups of three digits.
fn grouped(value: f64) -> String {
    let digits = format!("{:.0}", value.abs());
    let mut out = String::from(if value < 0. { "-" } else { "" });
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

impl RenderOnce for TokenInputControl {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let draft = draft(&self.id, self.value, window, cx);
        let slider_value = parse(&draft.text.read(cx).clone())
            .map_or(self.value, |parsed| parsed.clamp(self.min, self.max));
        let (value, min, max) = (self.value, self.min, self.max);
        let on_commit = self.on_commit;
        let commit: Commit = Rc::new(
            move |raw: &str, draft: &Draft, window: &mut Window, cx: &mut App| {
                let (text, next) = resolve(raw, value, min, max);
                set_text(&draft.text, text, cx);
                if let (Some((next, clamped)), Some(on_commit)) = (next, &on_commit) {
                    on_commit(next, clamped, window, cx);
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
                caption: format!("{} / {}", grouped(slider_value), grouped(self.max)),
            },
            &draft,
            commit,
            window,
            cx,
        )
    }
}
