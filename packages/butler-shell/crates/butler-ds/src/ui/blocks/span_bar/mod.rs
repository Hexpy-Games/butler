//! DS SpanBar (`SpanBar.tsx`, `SpanAxis.tsx`, `spanGeometry.ts`, `SpanBar.module.css`): one span
//! of a trace on the trace's shared time axis. `SpanBar` is a pill on a 6px track, split over a
//! parent's children; `SpanAxis` labels the axis; `SpanRow` places a trace row at its depth.
//! Every bar of a trace shares one `total`, so start offsets and durations line up across rows.
mod axis;
mod bar;
mod geometry;
mod row;

pub use axis::{SpanAxis, SpanInset};
pub use bar::{SpanBar, SpanSegment, SpanTone};
pub use geometry::format_span_ms;
pub use row::{SPAN_TEXT_INDENT_CAP, SpanIndent, SpanRow, span_rows};
