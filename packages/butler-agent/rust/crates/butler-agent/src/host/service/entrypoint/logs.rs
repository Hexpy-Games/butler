//! Timestamped output for desktop and CLI service entrypoints.

#[derive(Clone, Copy)]
pub(super) struct ServiceLogMode {
    stderr: bool,
    quiet: bool,
}

impl ServiceLogMode {
    pub(super) fn desktop() -> Self {
        Self {
            stderr: false,
            quiet: false,
        }
    }

    pub(super) fn cli(quiet: bool) -> Self {
        Self {
            stderr: true,
            quiet,
        }
    }

    pub(super) fn write(self, message: &str) {
        if !self.quiet {
            self.problem(message);
        }
    }

    /// Writes even in quiet mode: a problem the operator must see.
    pub(super) fn problem(self, message: &str) {
        let message = butler_core::diagnostics::timestamped(message);
        if self.stderr {
            eprintln!("{message}");
        } else {
            println!("{message}");
        }
    }
}
