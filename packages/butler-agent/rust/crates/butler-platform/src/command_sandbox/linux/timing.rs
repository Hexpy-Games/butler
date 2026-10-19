//! Opt-in helper profiling; no clocks or output in production builds.
#[derive(Default)]
pub(super) struct Timing {
    #[cfg(feature = "test-support")]
    state: Option<State>,
}

#[cfg(feature = "test-support")]
struct State {
    start: std::time::Instant,
    last: std::time::Instant,
    phases: Vec<(&'static str, u128)>,
}

impl Timing {
    pub(super) fn new() -> Self {
        #[cfg(feature = "test-support")]
        if std::env::var_os("BUTLER_TEST_SANDBOX_TIMINGS").is_some() {
            let now = std::time::Instant::now();
            return Self {
                state: Some(State {
                    start: now,
                    last: now,
                    phases: Vec::new(),
                }),
            };
        }
        Self::default()
    }

    pub(super) fn mark(&mut self, name: &'static str) {
        let _ = name;
        #[cfg(feature = "test-support")]
        if let Some(State { last, phases, .. }) = &mut self.state {
            let now = std::time::Instant::now();
            phases.push((name, now.duration_since(*last).as_micros()));
            *last = now;
        }
    }

    pub(super) fn report(&self, tier: super::mountns::Tier) {
        let _ = tier;
        #[cfg(feature = "test-support")]
        if let Some(State { start, phases, .. }) = &self.state {
            eprint!(
                "butler_sandbox_setup_us={} tier={}",
                start.elapsed().as_micros(),
                match tier {
                    super::mountns::Tier::MPlus => "M+",
                    super::mountns::Tier::M => "M",
                    super::mountns::Tier::L => "L",
                }
            );
            for (name, micros) in phases {
                eprint!(" {name}_us={micros}");
            }
            eprintln!();
        }
    }
}
