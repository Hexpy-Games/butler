//! Hidden top-level window: message-only windows do not get power broadcasts.
use winsafe::{co, gui, prelude::*};

pub(super) fn start() {
    if let Err(error) = std::thread::Builder::new()
        .name("system-wake".into())
        .spawn(|| {
            let window = gui::WindowMain::new(gui::WindowMainOpts {
                // Exclude WS_VISIBLE at creation, as well as hiding on run_main.
                style: co::WS::OVERLAPPED,
                ex_style: co::WS_EX::TOOLWINDOW,
                size: (0, 0),
                ..Default::default()
            });
            window.on().wm_power_broadcast(|message| {
                if matches!(
                    message.event,
                    co::PBT::APMRESUMEAUTOMATIC | co::PBT::APMRESUMESUSPEND
                ) {
                    super::emit();
                }
                Ok(())
            });
            if let Err(error) = window.run_main(Some(co::SW::HIDE)) {
                eprintln!("[system-wake] power window stopped: {error}");
            }
        })
    {
        eprintln!("[system-wake] power window thread unavailable: {error}");
    }
}
