//! The morph simulation (thinking-mark/motion.ts): one critically damped spring takes the mark
//! from the logo (0) to the thinking form (1) and back, and a motion clock runs with it.

/// `MORPH_SPRING`: k 6, zeta 1 (about 0.7 s to half and 1.9 s to 95%, no overshoot).
const K: f32 = 6.; // DS: constants.ts:30
const ZETA: f32 = 1.; // DS: constants.ts:30
/// Morph progress by which the motion clock reaches full speed.
const FULL_SPEED_AT: f32 = 0.3; // DS: constants.ts:38
/// A stalled frame advances at most this far.
const MAX_STEP_S: f32 = 0.05; // DS: constants.ts:71
const SUBSTEP_S: f32 = 0.005; // DS: constants.ts:72

#[derive(Clone, Copy, Debug)]
pub(crate) struct MorphSim {
    /// Spring position and velocity.
    x: f32,
    v: f32,
    th: f32,
    th0: f32,
    pub(super) idle: bool,
    pub(super) start_ms: u32,
    pub(super) working: bool,
}

impl Default for MorphSim {
    fn default() -> Self {
        Self {
            x: 0.,
            v: 0.,
            th: 0.,
            th0: 0.,
            idle: true,
            start_ms: gpui::animation_time_ms(),
            working: false,
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

    /// Re-derives the spring on the motion clock in the same bounded substeps as each frame.
    pub(super) fn update(&mut self, elapsed: f32, working: bool) {
        let mut remaining = elapsed;
        let damping = 2. * ZETA * K.sqrt();
        while remaining > 0. && !self.idle {
            if self.working && (self.x - 1.).abs() < 1e-4 && self.v.abs() < 1e-4 {
                self.th += remaining;
                break;
            }
            let dt = remaining.min(MAX_STEP_S);
            let target = if self.working { 1. } else { 0. };
            let steps = (dt / SUBSTEP_S).ceil();
            let h = dt / steps;
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "at most ten spring substeps"
            )]
            for _ in 0..steps as usize {
                self.v += (K * (target - self.x) - damping * self.v) * h;
                self.x += self.v * h;
            }
            let t = (self.progress() / FULL_SPEED_AT).clamp(0., 1.);
            self.th += dt * t * t * (3. - 2. * t);
            self.idle = !self.working && self.x.abs() < 0.003 && self.v.abs() < 0.01;
            if self.idle {
                self.x = 0.;
                self.v = 0.;
            }
            remaining -= dt;
        }
        if working && self.idle {
            self.th0 = self.th;
            self.idle = false;
        }
        self.working = working;
    }

    /// Reduced motion has no morph: rest at the logo, so leaving it starts from the logo.
    pub(super) fn park(&mut self) {
        self.x = 0.;
        self.v = 0.;
        self.idle = true;
        self.start_ms = gpui::animation_time_ms();
        self.working = false;
    }
}
