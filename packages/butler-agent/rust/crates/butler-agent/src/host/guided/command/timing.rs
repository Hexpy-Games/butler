//! Opt-in, content-free timings for command execution diagnostics.
use std::time::Instant;

pub(super) struct CommandTiming {
    phase: &'static str,
    started: Option<Instant>,
}

impl CommandTiming {
    pub(super) fn new(phase: &'static str) -> Self {
        Self {
            phase,
            started: (std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
                == Some(std::ffi::OsStr::new("1")))
            .then(Instant::now),
        }
    }
}

impl Drop for CommandTiming {
    fn drop(&mut self) {
        if let Some(started) = self.started {
            eprintln!(
                "command_phase_timing phase={} elapsed_us={}",
                self.phase,
                started.elapsed().as_micros()
            );
        }
    }
}
