//! The browser split's chat width, persisted like Electron's `butler-browser-shell` store (`chatWidth`).
use gpui::{App, Global, Task};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

struct SplitWidth {
    path: PathBuf,
    width: Option<f32>,
    dirty: bool,
    timer: Option<Task<()>>,
}
impl Global for SplitWidth {}

pub(super) fn init(cx: &mut App) {
    let path = crate::lifecycle::data_root(&std::env::args_os().collect::<Vec<_>>())
        .join("app/browser/browser-shell.json");
    let width = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|mut value: serde_json::Value| {
            serde_json::from_value::<f32>(value["chatWidth"].take()).ok()
        })
        .filter(|width| width.is_finite());
    cx.set_global(SplitWidth {
        path,
        width,
        dirty: false,
        timer: None,
    });
}

pub(crate) fn saved(cx: &App) -> Option<f32> {
    cx.try_global::<SplitWidth>().and_then(|state| state.width)
}

pub(crate) fn changed(width: f32, cx: &mut App) {
    if !cx.has_global::<SplitWidth>() {
        return;
    }
    let state = cx.global_mut::<SplitWidth>();
    if state.width == Some(width) && !state.dirty {
        return;
    }
    state.width = Some(width);
    state.dirty = true;
    state.timer = None;
    let timer = cx.spawn(async move |cx| {
        crate::ui::source::fetch::sleep(cx, Duration::from_secs(1)).await;
        cx.update(flush);
    });
    cx.global_mut::<SplitWidth>().timer = Some(timer);
}

fn flush(cx: &mut App) {
    let state = cx.global_mut::<SplitWidth>();
    if !state.dirty {
        return;
    }
    if let Err(error) = write(&state.path, state.width.unwrap_or_default()) {
        eprintln!("browser split width write failed: {error}");
    } else {
        state.dirty = false;
    }
}

pub(crate) fn flush_now(cx: &mut App) {
    if !cx.has_global::<SplitWidth>() {
        return;
    }
    cx.global_mut::<SplitWidth>().timer = None;
    flush(cx);
}

fn write(path: &Path, width: f32) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("browser split width directory"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    butler_platform::secure_fs::owner_only(&mut options);
    let file = options.open(&temporary)?;
    serde_json::to_writer(file, &serde_json::json!({"chatWidth": width}))?;
    fs::rename(temporary, path)
}
