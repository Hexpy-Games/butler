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
        fn on_before_command_line_processing(&self, process: Option<&CefString>, command: Option<&mut CommandLine>) {
            if process.is_none_or(|value| value.to_string().is_empty()) && let Some(command) = command {
                // The shell's synchronous policy must see automatic requests too.
                command.append_switch(Some(&"disable-popup-blocking".into()));
            }
        }
    }
}
