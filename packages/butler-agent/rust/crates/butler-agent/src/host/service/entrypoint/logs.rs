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

    /// The underlying causes of a failure that ends the service, which its
    /// code and message alone do not name (SQLite's own text, for example).
    pub(super) fn causes(self, error: &butler_turn::btcc::BtccError) {
        let mut parts: Vec<String> = Vec::new();
        let mut cause = std::error::Error::source(error);
        while let Some(current) = cause {
            let text = current.to_string();
            // A wrapper's Display often repeats its source's text.
            if !parts.last().is_some_and(|last| last.ends_with(&text)) {
                parts.push(text);
            }
            cause = current.source();
        }
        if !parts.is_empty() {
            self.problem(&format!(
                "[native-service] code={} cause={}",
                error.code(),
                parts.join(" <- ")
            ));
        }
    }
}
