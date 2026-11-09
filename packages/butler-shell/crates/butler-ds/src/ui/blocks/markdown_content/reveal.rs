//! The streaming reveal (`streamingReveal.ts`, `useStreamingReveal`): every chunk appended to the
//! source fades in over `--motion-base`, opacity only, so nothing moves while a reply grows.
//! Settled text (streaming off) is plain.
use std::time::Duration;

use gpui::{App, ElementId, Window};

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::{Timing, Transition};

/// Chunks younger than this fade (fade duration plus margin: `STREAM_REVEAL_WINDOW_MS`).
const WINDOW: Duration = Duration::from_millis(400);

#[derive(Clone, Debug)]
struct Chunk {
    /// Source offset where the chunk starts.
    start: usize,
    at: u32,
}

#[derive(Default)]
struct Tracker {
    text: String,
    chunks: Vec<Chunk>,
}

/// The fade of each chunk of the current text at one frame.
#[derive(Clone, Default)]
pub struct Reveal {
    /// `(start offset, opacity)`, in arrival order.
    chunks: Vec<(usize, u32)>,
    timing: Option<Timing>,
}

impl Reveal {
    /// The opacity of the text at source offset `start`: its covering chunk's fade (the latest
    /// chunk that starts at or before it), 1 where no chunk covers it.
    pub(super) fn alpha_at(&self, start: usize) -> Option<(Transition, Timing)> {
        let timing = self.timing?;
        self.chunks
            .iter()
            .rev()
            .find(|(chunk, _)| *chunk <= start)
            .and_then(|(_, at)| {
                let value = Transition {
                    from: 0.,
                    to: 1.,
                    start_ms: *at,
                };
                value.moving(&timing).then_some((value, timing))
            })
    }

    /// The offsets strictly inside `start..end` where a new chunk begins.
    pub(super) fn cuts(&self, start: usize, end: usize) -> Vec<usize> {
        self.chunks
            .iter()
            .map(|(chunk, _)| *chunk)
            .filter(|chunk| *chunk > start && *chunk < end)
            .collect()
    }

    /// Whether any chunk is still fading.
    pub fn fading(&self) -> bool {
        self.chunks
            .iter()
            .any(|(start, _)| self.alpha_at(*start).is_some())
    }
}

/// `useStreamingReveal(text, active)`: tracks the chunks `text` has grown by since the last call
/// and returns their fades. The first call of a message shows its existing text without a fade;
/// text that is not an extension of the last (an edit) starts over; `active` off clears all.
pub fn track(
    id: impl Into<ElementId>,
    text: &str,
    active: bool,
    window: &mut Window,
    cx: &mut App,
) -> Reveal {
    let state = window.use_keyed_state((id.into(), "reveal"), cx, |_, _| Tracker::default());
    let now = gpui::animation_time_ms();
    let timing = Timing::token(
        Ds::get(cx),
        DsDuration::MotionBase,
        Easing::MotionEaseStandard,
    );
    state.update(cx, |tracker, _| {
        if !active {
            *tracker = Tracker {
                text: text.to_owned(),
                chunks: Vec::new(),
            };
        } else if text != tracker.text {
            if text.starts_with(&tracker.text) {
                tracker.chunks.push(Chunk {
                    start: tracker.text.len(),
                    at: now,
                });
            } else {
                tracker.chunks.clear();
            }
            text.clone_into(&mut tracker.text);
        }
        tracker.chunks.retain(|chunk| {
            Duration::from_millis(u64::from(now.wrapping_sub(chunk.at))) <= WINDOW + timing.duration
        });
        Reveal {
            chunks: tracker
                .chunks
                .iter()
                .map(|chunk| (chunk.start, chunk.at))
                .collect(),
            timing: Some(timing),
        }
    })
}
