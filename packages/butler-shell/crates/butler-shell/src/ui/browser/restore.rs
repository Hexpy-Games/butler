//! Own tabs only, persisted after a change and restored once (`browser/restore.mjs`).
use gpui::BorrowAppContext as _;

use super::{
    address::web_url,
    model::{BrowserState, Owner},
};
use gpui::{App, Global, Task};
use std::{
    fs, io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

struct Storage {
    path: PathBuf,
    revision: AtomicU64,
    saved: AtomicU64,
    lock: Mutex<()>,
}
struct TabRestore {
    dirty: bool,
    timer: Option<Task<()>>,
    restored: bool,
    reading: bool,
    storage: Arc<Storage>,
}
impl Global for TabRestore {}
pub(super) fn init(cx: &mut App) {
    let path = crate::lifecycle::data_root(&std::env::args_os().collect::<Vec<_>>())
        .join("app/browser/browser-tabs.json");
    cx.set_global(TabRestore {
        dirty: false,
        timer: None,
        restored: false,
        reading: false,
        storage: Arc::new(Storage {
            path,
            revision: AtomicU64::new(0),
            saved: AtomicU64::new(0),
            lock: Mutex::new(()),
        }),
    });
}
pub(super) fn changed(cx: &mut App) {
    let state = cx.global_mut::<TabRestore>();
    if !state.restored {
        return;
    }
    state.dirty = true;
    state.timer = None;
    let timer = cx.spawn(async move |cx| {
        crate::ui::source::fetch::sleep(cx, Duration::from_secs(2)).await;
        cx.update(flush);
    });
    cx.global_mut::<TabRestore>().timer = Some(timer);
}
fn snapshot(cx: &App) -> Vec<String> {
    cx.global::<BrowserState>()
        .tabs()
        .iter()
        .filter(|tab| tab.owner == Owner::Mine && !tab.popup)
        .map(|tab| tab.url.clone())
        .collect()
}
fn flush(cx: &mut App) {
    if !cx.global::<TabRestore>().dirty {
        return;
    }
    let urls = snapshot(cx);
    let state = cx.global_mut::<TabRestore>();
    state.dirty = false;
    let storage = state.storage.clone();
    let revision = storage.revision.fetch_add(1, Ordering::SeqCst) + 1;
    let write = cx
        .background_executor()
        .spawn(async move { storage.write(revision, &urls) });
    cx.spawn(async move |cx| {
        if let Err(error) = write.await {
            cx.update(|cx| cx.global_mut::<TabRestore>().dirty = true);
            eprintln!("browser tab restore write failed: {error}");
        }
    })
    .detach();
}
pub(crate) fn flush_now(cx: &mut App) {
    let Some(state) = cx.try_global::<TabRestore>() else {
        return;
    };
    if !state.restored {
        return;
    }
    if !state.dirty
        && state.storage.saved.load(Ordering::SeqCst)
            == state.storage.revision.load(Ordering::SeqCst)
    {
        return;
    }
    let urls = snapshot(cx);
    let state = cx.global_mut::<TabRestore>();
    state.timer = None;
    let revision = state.storage.revision.fetch_add(1, Ordering::SeqCst) + 1;
    if let Err(error) = state.storage.write(revision, &urls) {
        eprintln!("browser tab restore write failed: {error}");
    } else {
        state.dirty = false;
    }
}
impl Storage {
    fn write(&self, revision: u64, urls: &[String]) -> io::Result<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("tab restore write lock"))?;
        if self.revision.load(Ordering::SeqCst) != revision {
            return Ok(());
        }
        let parent = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("tab restore directory"))?;
        fs::create_dir_all(parent)?;
        let temporary = self.path.with_extension("json.tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        butler_platform::secure_fs::owner_only(&mut options);
        let file = options.open(&temporary)?;
        serde_json::to_writer(file, urls)?;
        fs::rename(temporary, &self.path)?;
        self.saved.store(revision, Ordering::SeqCst);
        Ok(())
    }
}
pub(super) fn ready(cx: &mut App) -> bool {
    let state = cx.global_mut::<TabRestore>();
    if state.restored {
        return true;
    }
    if state.reading {
        return false;
    }
    state.reading = true;
    let path = state.storage.path.clone();
    let read = cx.background_executor().spawn(async move {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<serde_json::Value>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| {
                value
                    .as_str()
                    .filter(|url| url.is_empty() || web_url(url).is_some())
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>()
    });
    cx.spawn(async move |cx| {
        let urls = read.await;
        cx.update(|cx| {
            cx.update_global::<BrowserState, _>(|model, cx| {
                let mut first = None;
                for url in urls {
                    match model.create(Owner::Mine, Some(&url), false, false, cx) {
                        Ok(Some(id)) => {
                            first.get_or_insert(id);
                        }
                        Ok(None) => {}
                        Err(error) => {
                            eprintln!("browser tab restore failed: {error}");
                        }
                    }
                }
                if model.active().is_none()
                    && let Some(id) = first
                {
                    model.activate(&id);
                }
            });
            cx.global_mut::<TabRestore>().restored = true;
            cx.refresh_windows();
        });
    })
    .detach();
    false
}
