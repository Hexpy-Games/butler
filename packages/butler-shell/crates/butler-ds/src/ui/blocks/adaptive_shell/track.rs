//! The motion of an AdaptiveShell's panels (useSidebarTrackMotion.ts, useInspectorTrackMotion.ts,
//! AdaptiveShellSplitMotion.ts): each panel, the scrim, the peek card and the split pane ease
//! on the panel tokens (`--adaptive-panel-duration` and `-easing`: slow, emphasized). Reduced
//! motion, a live resize and the settings screen place panels at once; panels then only fade.
use gpui::{App, Window};

use super::AdaptiveShell;
use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::blocks::anim::ramp;
use crate::ui::blocks::scope::SplitMotion;
use crate::ui::context::Ds;
use crate::ui::motion::Timing;

/// Every eased quantity of one frame, each 0 (closed) to 1 (open).
pub(super) struct Tracks {
    pub left: f32,
    /// The docked sidebar's fade (reduced motion).
    pub left_fade: f32,
    pub right: f32,
    pub right_fade: f32,
    pub scrim: f32,
    pub peek: f32,
    pub split: Option<SplitMotion>,
}

/// What the motion depends on besides the shell's inputs.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent layout facts, as the CSS data attributes of the shell"
)]
pub(super) struct Facts {
    pub drawer: bool,
    pub inspector_open: bool,
    pub peeking: bool,
    pub scrim_open: bool,
}

fn level(open: bool) -> f32 {
    f32::from(u8::from(open))
}

/// `context_key` changed since the last frame: the split places its new state at once.
fn context_changed(shell: &AdaptiveShell, window: &mut Window, cx: &mut App) -> bool {
    let Some(split) = shell.split else {
        return false;
    };
    let seen = window.use_keyed_state((shell.id.clone(), "split-context"), cx, |_, _| {
        split.context_key
    });
    let changed = *seen.read(cx) != split.context_key;
    if changed {
        seen.update(cx, |key, _| *key = split.context_key);
    }
    changed
}

pub(super) fn tracks(
    shell: &AdaptiveShell,
    facts: &Facts,
    window: &mut Window,
    cx: &mut App,
) -> Tracks {
    let context_changed = context_changed(shell, window, cx);
    let ds = Ds::get(cx);
    let panel = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    let fade_in = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
    let fade_out = Timing::token(ds, DsDuration::MotionExitFast, Easing::MotionEaseStandard);
    let peek_timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard);
    let reduced = ds.reduced_motion();
    let animate = !shell.resizing && !shell.settings_active;
    let left_jump = reduced || (!facts.drawer && !animate);
    let right_jump = reduced || (!facts.drawer && !animate);
    let id = &shell.id;
    let fade_timing = |open: bool| if open { &fade_in } else { &fade_out };
    let left = ramp(
        (id.clone(), "left"),
        (level(shell.left_open), left_jump),
        &panel,
        window,
        cx,
    );
    let left_fade = ramp(
        (id.clone(), "left-fade"),
        (level(shell.left_open), false),
        fade_timing(shell.left_open),
        window,
        cx,
    );
    let right = ramp(
        (id.clone(), "right"),
        (level(facts.inspector_open), right_jump),
        &panel,
        window,
        cx,
    );
    let right_fade = ramp(
        (id.clone(), "right-fade"),
        (level(facts.inspector_open), false),
        fade_timing(facts.inspector_open),
        window,
        cx,
    );
    let scrim = ramp(
        (id.clone(), "scrim"),
        (level(facts.scrim_open), reduced),
        &panel,
        window,
        cx,
    );
    let peek = ramp(
        (id.clone(), "peek"),
        (level(facts.peeking), false),
        &peek_timing,
        window,
        cx,
    );
    let split = shell.split.map(|split| {
        let progress = ramp(
            (id.clone(), "split"),
            (level(split.open), reduced || context_changed),
            &panel,
            window,
            cx,
        );
        let fade = ramp(
            (id.clone(), "split-fade"),
            (level(split.open), context_changed),
            &peek_timing,
            window,
            cx,
        );
        SplitMotion {
            progress,
            fade,
            open: split.open,
            chat_width: split.chat_width,
        }
    });
    Tracks {
        left,
        left_fade,
        right,
        right_fade,
        scrim,
        peek,
        split,
    }
}
