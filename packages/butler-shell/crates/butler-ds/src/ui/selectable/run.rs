//! A selectable text run; its flex child supplies the layout without an extra layout node.
use super::{Break, RunInfo, State, current, fill};
use crate::ui::context::Ds;
use gpui::{
    AnyElement, App, Bounds, CursorStyle, Element, ElementId, Entity, GlobalElementId, Hitbox,
    HitboxBehavior, InspectorElementId, IntoElement, LayoutId, ParentElement as _, Pixels,
    SharedString, Styled as _, StyledText, TextLayout, Window, div, point, px, size,
};

pub struct Run {
    child: Option<AnyElement>,
    layout: TextLayout,
    text: SharedString,
    lead: Break,
    space_before: Pixels,
    space_after: Pixels,
}
impl Run {
    /// `styled` as selectable text; `finish` wraps it for drawing (an InteractiveText for links).
    pub fn new(
        text: SharedString,
        styled: StyledText,
        lead: Break,
        finish: impl FnOnce(StyledText) -> AnyElement,
    ) -> Self {
        let layout = styled.layout().clone();
        // A flex box lays the text out as its own box. In a block the text would join the
        // block's inline paragraph, which measures and paints it, so the text's own layout, the
        // one presses and drags map through, would never be measured.
        let child = div()
            .flex()
            .flex_col()
            .child(finish(styled))
            .into_any_element();
        Self {
            child: Some(child),
            layout,
            text,
            lead,
            space_before: px(0.),
            space_after: px(0.),
        }
    }
    pub fn plain(text: impl Into<SharedString>, lead: Break) -> Self {
        let text = text.into();
        Self::new(
            text.clone(),
            StyledText::new(text),
            lead,
            IntoElement::into_any_element,
        )
    }
    /// The whitespace margin before this run, filled when selection continues from an earlier run.
    pub fn space_before(mut self, gap: Pixels) -> Self {
        self.space_before = gap;
        self
    }
    /// Width of the whitespace margin after the run, filled when selection continues.
    pub fn space_after(mut self, gap: Pixels) -> Self {
        self.space_after = gap;
        self
    }
}
impl IntoElement for Run {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Run {
    type RequestLayoutState = AnyElement;
    type PrepaintState = Option<(Entity<State>, usize, Hitbox)>;
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .unwrap_or_else(|| gpui::Empty.into_any_element());
        (child.request_layout(window, cx), child)
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        child.prepaint(window, cx);
        let state = current(cx)?;
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        let index = state.update(cx, |s, _| {
            let index = s.runs.len();
            s.runs.push(RunInfo {
                layout: self.layout.clone(),
                text: self.text.clone(),
                lead: self.lead,
                space_before: self.space_before,
                space_after: self.space_after,
                hitbox: hitbox.clone(),
            });
            index
        });
        Some((state, index, hitbox))
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        registered: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some((state, index, hitbox)) = registered {
            let state = state.read(cx);
            if let Some((start, end)) = state
                .range()
                .filter(|(s, e)| s.run <= *index && *index <= e.run)
            {
                let run = &state.runs[*index];
                let s = if start.run == *index { start.offset } else { 0 };
                let e = if end.run == *index {
                    end.offset
                } else {
                    run.text.len()
                };
                paint_range(
                    run,
                    s,
                    e,
                    (start.run < *index, end.run > *index),
                    window,
                    cx,
                );
            }
            window.set_cursor_style(CursorStyle::IBeam, hitbox);
        }
        child.paint(window, cx);
    }
}

fn paint_range(
    run: &RunInfo,
    s: usize,
    e: usize,
    continues: (bool, bool),
    window: &mut Window,
    cx: &App,
) {
    if s == e {
        return;
    }
    let (Some(start), Some(end)) = (
        run.layout.position_for_index(s),
        run.layout.position_for_index(e),
    ) else {
        return;
    };
    let line = run.layout.line_height();
    if line <= px(0.) {
        return;
    }
    let bounds = run.layout.bounds();
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "ordered text positions give a nonnegative, rounded visual line count"
    )]
    let lines = ((end.y - start.y) / line).round() as usize;
    for i in 0..=lines {
        let y = start.y + line * i;
        let mut left = if i == 0 { start.x } else { bounds.left() };
        if i == 0 && s == 0 {
            if (bounds.left() - left).abs() * window.scale_factor() <= px(1.) {
                left = left.min(bounds.left());
            }
            if continues.0 {
                left -= run.space_before;
            }
        }
        let mut right = if i == lines {
            end.x
        } else {
            let index = run
                .layout
                .index_for_position(point(bounds.right(), y + line / 2.))
                .unwrap_or_else(|i| i);
            run.layout.position_for_index(index).map_or(left, |p| p.x)
        };
        if i == lines && e == run.text.len() {
            if (bounds.right() - right).abs() * window.scale_factor() <= px(1.) {
                right = right.max(bounds.right());
            }
            if continues.1 {
                right += run.space_after;
            }
        }
        let scale = window.scale_factor();
        let snap = |v: Pixels| (v * scale).round() / scale;
        let (left, right, top, bottom) = (snap(left), snap(right), snap(y), snap(y + line));
        if right > left {
            window.paint_quad(
                gpui::PaintQuad::new(Bounds::new(
                    point(left, top),
                    size(right - left, bottom - top),
                ))
                .background(fill(Ds::get(cx))),
            );
        }
    }
}
