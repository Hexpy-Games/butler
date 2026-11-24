use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::bail;

use super::{Harness, ui};

pub(super) fn command(h: &mut Harness, verb: &str, arg: &str) -> Option<anyhow::Result<()>> {
    Some(match verb {
        "document" => h.update(|s, _, cx| {
            ui::manage::documents::open_document(&s.manage_ctx(), arg.to_owned().into(), cx);
        }),
        "save-path" => save_path(h, arg),
        "wait-file" => wait_file(h, arg),
        _ => return None,
    })
}

fn save_path(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        super::settle(&mut h.cx, h.handle);
        if h.cx.did_prompt_for_new_path() {
            h.cx.simulate_new_path_selection(|_| Some(PathBuf::from(arg)));
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("save path prompt deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_file(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        super::settle(&mut h.cx, h.handle);
        if std::fs::read(arg).is_ok_and(|b| b.trim_ascii_end().ends_with(b"%%EOF")) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("PDF file deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
