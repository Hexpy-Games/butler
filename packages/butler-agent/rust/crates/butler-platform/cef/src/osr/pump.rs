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
    }
}
