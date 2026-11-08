//! UsageBars view parts: the frame one render draws, the y gutter, the plot and the x axis.
use gpui::{AnyElement, App, Bounds, Pixels, Window, canvas, div, px};
use gpui::{InteractiveElement as _, IntoElement, ParentElement as _, Styled as _};

use super::{State, UsageBars, draw, layout};
use crate::tokens::{Color, Length};
use crate::ui::blocks::measure;
use crate::ui::context::Ds;

/// What one render draws.
pub(super) struct Frame<'a> {
    pub(super) geometry: &'a layout::Geometry,
    /// The height (px) each column is drawn at now.
    pub(super) drawn: &'a [(crate::ui::motion::Transition, crate::ui::motion::Timing)],
    pub(super) selected: Option<usize>,
    pub(super) ready: bool,
    pub(super) plot_h: f32,
    pub(super) headroom: f32,
}

impl UsageBars {
    /// The y gutter's labels (0, half, top) as a share of the drawing height.
    pub(super) fn y_labels(&self, frame: &Frame) -> Vec<(f32, String)> {
        let Some(format) = &self.y_ticks else {
            return Vec::new();
        };
        let ticks = if frame.ready {
            frame.geometry.ticks.clone()
        } else {
            Vec::new()
        };
        std::iter::once(0.)
            .chain(ticks)
            .map(|tick| (layout::narrow(tick / frame.geometry.top), format(tick)))
            .collect()
    }

    /// The plot: gridlines, columns (or the loading placeholder), the note, the empty line, the
    /// baseline, and the recorder of its bounds.
    pub(super) fn plot(
        &self,
        frame: &Frame,
        plot_bounds: &gpui::Entity<Bounds<Pixels>>,
        ds: &Ds,
        window: &mut Window,
    ) -> gpui::Stateful<gpui::Div> {
        let bounds = plot_bounds.clone();
        let recorder = canvas(
            |bounds: Bounds<Pixels>, _, _| bounds,
            move |_, area, _, cx| bounds.update(cx, |bounds, _| *bounds = area),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let mut plot = div()
            .id((self.id.clone(), "plot"))
            .relative()
            .flex()
            .items_end()
            .w_full()
            .h(px(frame.plot_h))
            .child(recorder);
        let slots = frame.geometry.slots;
        if self.state == State::Loading {
            plot = plot.children(draw::skeleton(slots, frame.plot_h, self.size, ds, window));
        }
        if frame.ready {
            plot = plot.children(frame.geometry.ticks.iter().map(|tick| {
                draw::gridline(
                    layout::narrow(tick / frame.geometry.top),
                    frame.plot_h,
                    frame.headroom,
                    ds,
                )
            }));
            let emphasis = self.emphasis;
            plot = plot.children(frame.geometry.columns.iter().enumerate().map(
                |(index, column)| {
                    draw::column(
                        column,
                        frame.drawn[index],
                        frame.selected == Some(index),
                        frame.selected.is_some(),
                        (self.size, emphasis, frame.plot_h),
                        ds,
                    )
                },
            ));
            // The empty slots keep the grid.
            for _ in frame.geometry.columns.len()..slots {
                plot = plot.child(div().flex_1().min_w_0());
            }
            plot = plot.children(
                self.note
                    .clone()
                    .map(|note| draw::note(note, frame.geometry.columns.len(), slots, ds)),
            );
        }
        if self.state != State::Loading && !frame.ready {
            plot = plot.children(
                self.empty_label
                    .clone()
                    .map(|text| draw::empty(text, self.size, ds)),
            );
        }
        // The baseline.
        plot.child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .h(px(1.))
                .bg(ds.color(Color::Line)),
        )
    }

    /// The x axis with its labels fitted to the width the axis had last frame.
    pub(super) fn axis(&self, frame: &Frame, window: &mut Window, cx: &mut App) -> AnyElement {
        let (size, recorder) = measure::track((self.id.clone(), "axis"), window, cx);
        let labels: Vec<(usize, &str)> = if self.state == State::Loading {
            Vec::new()
        } else {
            self.axis_labels
                .iter()
                .map(|label| (label.index, label.text.as_ref()))
                .collect()
        };
        let placements = layout::place_axis_labels(&labels, frame.geometry.slots, self.size);
        let widths: Vec<f32> = placements
            .iter()
            .map(|placed| measure::text_width(&placed.text, Length::TypoCaptionSize, window, cx))
            .collect();
        let ds = Ds::get(cx);
        let width = f32::from(size.width);
        let fits = if width > 0. {
            draw::fit(
                &placements,
                &widths,
                width,
                f32::from(ds.len(Length::SpaceSm)),
            )
        } else {
            placements
                .iter()
                .map(|_| draw::Fit {
                    hidden: false,
                    nudge: 0.,
                })
                .collect()
        };
        div()
            .relative()
            .min_w_0()
            .child(recorder)
            .child(draw::x_axis(&placements, &fits, width, ds))
            .into_any_element()
    }
}
