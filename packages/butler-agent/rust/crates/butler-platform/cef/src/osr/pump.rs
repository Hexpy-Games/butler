#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::PumpScheduler;
use cef::*;
use std::time::Duration;

cef::wrap_browser_process_handler! {
    pub(super) struct Pump { schedule: PumpScheduler }
    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            (self.schedule)(Duration::from_millis(u64::try_from(delay_ms).unwrap_or(0)));
        }
    }
}
cef::wrap_app! {
    pub(super) struct OsrApp { pump: BrowserProcessHandler }
    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> { Some(self.pump.clone()) }
        // The browser process only: helpers (`--type=…`) take what they need from it.
        fn on_before_command_line_processing(&self, process: Option<&CefString>, command: Option<&mut CommandLine>) {
            if process.is_none_or(|value| value.to_string().is_empty()) && let Some(command) = command {
                // The shell's synchronous policy must see automatic requests too.
                command.append_switch(Some(&"disable-popup-blocking".into()));
                quiet(command);
            }
        }
    }
}

/// Chrome's background services and Google calls off (`crate::switches`). Not the executor's
/// other switches: the visible browser browses directly and keeps the OS password store.
fn quiet(command_line: &CommandLine) {
    use crate::switches::{QUIET, VISIBLE_ONLY};
    for &(switch, value) in QUIET.iter().chain(VISIBLE_ONLY) {
        let name = CefString::from(switch);
        let Some(value) = value else {
            command_line.append_switch(Some(&name));
            continue;
        };
        // Merged with the features already disabled (the command line's, then each list's).
        let value = if switch == "disable-features" {
            let existing = CefString::from(&command_line.switch_value(Some(&name))).to_string();
            crate::switches::merge_disabled_features(&existing, value)
        } else {
            value.to_owned()
        };
        command_line.append_switch_with_value(Some(&name), Some(&CefString::from(value.as_str())));
    }
}
