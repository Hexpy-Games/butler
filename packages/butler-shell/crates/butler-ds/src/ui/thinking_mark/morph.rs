//! The morph simulation (thinking-mark/motion.ts): one critically damped spring takes the mark
//! from the logo (0) to the thinking form (1) and back, and a motion clock runs with it.
use std::time::Instant;

/// `MORPH_SPRING`: k 6, zeta 1 (about 0.7 s to half and 1.9 s to 95%, no overshoot).
const K: f32 = 6.; // DS: constants.ts:30
const ZETA: f32 = 1.; // DS: constants.ts:30
/// Morph progress by which the motion clock reaches full speed.
const FULL_SPEED_AT: f32 = 0.3; // DS: constants.ts:38
/// A stalled frame advances at most this far.
const MAX_STEP_S: f32 = 0.05; // DS: constants.ts:71
const SUBSTEP_S: f32 = 0.005; // DS: constants.ts:72

#[derive(Clone, Debug)]
pub(crate) struct MorphSim {
    /// Spring position and velocity.
    x: f32,
    v: f32,
    th: f32,
    th0: f32,
    pub(super) idle: bool,
    last: Option<Instant>,
}

impl Default for MorphSim {
    fn default() -> Self {
        Self {
            x: 0.,
            v: 0.,
            th: 0.,
            th0: 0.,
            idle: true,
            last: None,
        }
    }
}

impl MorphSim {
    /// Morph progress in 0..=1.
    pub(super) fn progress(&self) -> f32 {
        self.x.clamp(0., 1.)
    }

    /// The motion clock.
    pub(super) fn time(&self) -> f32 {
        self.th - self.th0
    }

    /// Steps to `now` (once per frame, however many marks share this simulation).
    pub(super) fn update(&mut self, now: Instant, working: bool) {
        let dt = match self.last.replace(now) {
            Some(last) if last == now => return,
            Some(last) => now
                .saturating_duration_since(last)
                .as_secs_f32()
                .min(MAX_STEP_S),
            None => 1. / 60.,
        };
        if working && self.idle {
            self.th0 = self.th;
        }
        let target = if working { 1. } else { 0. };
        let damping = 2. * ZETA * K.sqrt();
        let steps = (dt / SUBSTEP_S).ceil().clamp(1., 64.);
        let h = dt / steps;
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "1..=64"
        )]
        for _ in 0..steps as usize {
            self.v += (K * (target - self.x) - damping * self.v) * h;
            self.x += self.v * h;
        }
        // The motion clock rises smoothly from 0 with the morph and is exactly 1 from 0.3 on.
        let t = (self.progress() / FULL_SPEED_AT).clamp(0., 1.);
        self.th += dt * t * t * (3. - 2. * t);
        self.idle = !working && self.x.abs() < 0.003 && self.v.abs() < 0.01;
        if self.idle {
            self.x = 0.;
            self.v = 0.;
        }
    }

    /// Reduced motion has no morph: rest at the logo, so leaving it starts from the logo.
    pub(super) fn park(&mut self) {
        self.x = 0.;
        self.v = 0.;
        self.idle = true;
        self.last = None;
    }
}
