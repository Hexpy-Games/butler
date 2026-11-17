#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::PumpScheduler;
use cef::*;
use std::time::Duration;

cef::wrap_browser_process_handler! {
    pub(super) struct Pump { schedule: PumpScheduler, job: Option<String> }
    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            (self.schedule)(Duration::from_millis(u64::try_from(delay_ms).unwrap_or(0)));
        }
        // Every helper joins the App's kill-on-close job (`crate::job`), so none outlives the App.
        fn on_before_child_process_launch(&self, command: Option<&mut CommandLine>) {
            if let (Some(name), Some(command)) = (&self.job, command) {
                for (switch, value) in [
                    (crate::switches::OSR_JOB, name.clone()),
                    (crate::switches::OSR_APP, std::process::id().to_string()),
                ] {
                    command.append_switch_with_value(
                        Some(&switch.into()),
                        Some(&CefString::from(value.as_str())),
                    );
                }
            }
        }
    }
}
cef::wrap_app! {
    pub(super) struct OsrApp { pump: BrowserProcessHandler, adapter: Option<u64> }
    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> { Some(self.pump.clone()) }
        // The browser process only: helpers (`--type=…`) take what they need from it.
        fn on_before_command_line_processing(&self, process: Option<&CefString>, command: Option<&mut CommandLine>) {
            if process.is_none_or(|value| value.to_string().is_empty()) && let Some(command) = command {
                // The shell's synchronous policy must see automatic requests too.
                command.append_switch(Some(&"disable-popup-blocking".into()));
                // Electron parity (main.mjs:361, on every platform): without it CEF ends the whole process after 3 GPU crashes.
                command.append_switch(Some(&"disable-gpu-process-crash-limit".into()));
                quiet(command);
                if let Some(luid) = self.adapter {
                    adapter(command, luid);
                }
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

/// Put CEF's GPU process on the frames' consumer adapter (`OsrConfig::adapter_luid`), so its
/// shared textures open on the copy device. Chromium copies `use-adapter-luid` from the browser
/// process to the GPU process, whose ANGLE display then picks that adapter.
#[cfg(windows)]
fn adapter(command_line: &CommandLine, luid: u64) {
    let value = adapter_switch_value(luid);
    command_line.append_switch_with_value(
        Some(&"use-adapter-luid".into()),
        Some(&CefString::from(value.as_str())),
    );
}
/// macOS has one GPU path; the LUID is not used there.
#[cfg(not(windows))]
fn adapter(_: &CommandLine, _: u64) {}

/// Chromium's format (ui/gl/gl_display.cc): `LUID.HighPart` (signed) and `LUID.LowPart`
/// (unsigned) in decimal, comma-separated. A LUID no adapter has falls back to the default
/// adapter, but a malformed value (hex, say) fails GPU initialization and CEF exits.
#[cfg(windows)]
fn adapter_switch_value(luid: u64) -> String {
    let [h0, h1, h2, h3, l0, l1, l2, l3] = luid.to_be_bytes();
    let high = i32::from_be_bytes([h0, h1, h2, h3]);
    let low = u32::from_be_bytes([l0, l1, l2, l3]);
    format!("{high},{low}")
}
