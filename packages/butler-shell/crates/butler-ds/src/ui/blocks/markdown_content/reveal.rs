//! The streaming reveal (`streamingReveal.ts`, `useStreamingReveal`): every chunk appended to the
//! source fades in over `--motion-base`, opacity only, so nothing moves while a reply grows.
//! Settled text (streaming off) is plain.
use std::time::{Duration, Instant};

use gpui::{App, ElementId, Window};

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::convert;

/// Chunks younger than this fade (fade duration plus margin: `STREAM_REVEAL_WINDOW_MS`).
const WINDOW: Duration = Duration::from_millis(400);

#[derive(Clone, Debug)]
struct Chunk {
    /// Source offset where the chunk starts.
    start: usize,
    at: Instant,
}

#[derive(Default)]
struct Tracker {
    text: String,
    chunks: Vec<Chunk>,
}

/// The fade of each chunk of the current text at one frame.
#[derive(Clone, Debug, Default)]
pub struct Reveal {
    /// `(start offset, opacity)`, in arrival order.
    chunks: Vec<(usize, f32)>,
}

impl Reveal {
    /// The opacity of the text at source offset `start`: its covering chunk's fade (the latest
    /// chunk that starts at or before it), 1 where no chunk covers it.
    pub(super) fn alpha_at(&self, start: usize) -> f32 {
        self.chunks
            .iter()
            .rev()
            .find(|(chunk, _)| *chunk <= start)
            .map_or(1., |(_, alpha)| *alpha)
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
        self.chunks.iter().any(|(_, alpha)| *alpha < 1.)
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
    let now = cx.background_executor().now();
    let (timing, ease) = {
        let ds = Ds::get(cx);
        (
            ds.duration(DsDuration::MotionBase),
            ds.tokens().ease(Easing::MotionEaseStandard),
        )
    };
    let reveal = state.update(cx, |tracker, _| {
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
        tracker
            .chunks
            .retain(|chunk| now.saturating_duration_since(chunk.at) <= WINDOW + timing);
        Reveal {
            chunks: tracker
                .chunks
                .iter()
                .map(|chunk| {
                    let age = now.saturating_duration_since(chunk.at).as_secs_f32();
                    let t = (age / timing.as_secs_f32()).clamp(0., 1.);
                    (chunk.start, convert::ease_at(ease, t))
                })
                .collect(),
        }
    });
    if reveal.fading() {
        window.request_animation_frame();
    }
    reveal
}
