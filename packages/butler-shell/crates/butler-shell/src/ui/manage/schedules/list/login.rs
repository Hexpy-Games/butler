//! `hintScheduleLogin` (`app/loginSettings.ts`): once, tell the owner that schedules need Start
//! at login.
use std::sync::atomic::{AtomicBool, Ordering};

use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_platform::login_item::{self, LoginItem};
use gpui::App;

use super::copy::words;

/// React keeps "shown" in `localStorage` (`butler:schedule-login-hint:v1`); the shell has no
/// such store yet, so it is kept for this run.
static SHOWN: AtomicBool = AtomicBool::new(false);

/// Toasts the hint unless it was shown, the login item is on, or this build has none.
pub(crate) fn hint_login(cx: &mut App) {
    if SHOWN.load(Ordering::Relaxed) {
        return;
    }
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    if login_item::status(&executable) != LoginItem::Off {
        return;
    }
    SHOWN.store(true, Ordering::Relaxed);
    let text = words(Ds::get(cx).lang()).login_hint;
    toast::show(cx, Toast::message(text));
}
