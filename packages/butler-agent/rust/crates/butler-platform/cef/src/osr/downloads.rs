#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::{DownloadDecision, DownloadRequest, OsrEvent, OsrRuntime, RuntimeState, state::Events};
use cef::*;
use std::{collections::HashMap, path::Path, rc::Weak};

#[derive(Default)]
pub(super) struct Transfers {
    before: HashMap<u32, BeforeDownloadCallback>,
    active: HashMap<u32, DownloadItemCallback>,
    cancelled: std::collections::HashSet<u32>,
}

wrap_download_handler! {
    pub(super) struct Downloads { events: Events, runtime: Weak<RuntimeState> }
    impl DownloadHandler {
        fn can_download(&self, _browser: Option<&mut Browser>, _url: Option<&CefString>,
            _method: Option<&CefString>) -> i32 { 1 }
        fn on_before_download(&self, _browser: Option<&mut Browser>, item: Option<&mut DownloadItem>,
            name: Option<&CefString>, callback: Option<&mut BeforeDownloadCallback>) -> i32 {
            let (Some(runtime), Some(item), Some(callback)) = (self.runtime.upgrade(), item, callback) else { return 0; };
            let id = item.id();
            let suggested_name = name.map(ToString::to_string).unwrap_or_default();
            let total_bytes = u64::try_from(item.total_bytes()).unwrap_or(0);
            let request = DownloadRequest { page: self.events.page, id, suggested_name: suggested_name.clone(), total_bytes };
            let decision = (runtime.downloads)(&request);
            let Some(page) = runtime.pages.borrow().get(&self.events.page).cloned() else { return 1; };
            page.borrow_mut().downloads.before.insert(id, callback.clone());
            self.events.emit(OsrEvent::DownloadStarted { id, suggested_name: suggested_name.clone(), total_bytes });
            match decision {
                DownloadDecision::Dialog => continue_to(&page, id, &suggested_name, true),
                DownloadDecision::Stage(path) => continue_to(&page, id, &path.to_string_lossy(), false),
            }
            1
        }
        fn on_download_updated(&self, _browser: Option<&mut Browser>, item: Option<&mut DownloadItem>,
            callback: Option<&mut DownloadItemCallback>) {
            let (Some(runtime), Some(item), Some(callback)) = (self.runtime.upgrade(), item, callback) else { return; };
            let id = item.id();
            let Some(page) = runtime.pages.borrow().get(&self.events.page).cloned() else { return; };
            let cancelled = {
                let mut page = page.borrow_mut();
                page.downloads.active.insert(id, callback.clone());
                page.downloads.cancelled.remove(&id)
            };
            if cancelled { callback.cancel(); }
            self.events.emit(OsrEvent::DownloadProgress { id,
                received: u64::try_from(item.received_bytes()).unwrap_or(0),
                total: u64::try_from(item.total_bytes()).unwrap_or(0) });
            if item.is_in_progress() == 0 {
                page.borrow_mut().downloads.active.remove(&id);
                self.events.emit(OsrEvent::DownloadDone { id, completed: item.is_complete() != 0 });
            }
        }
    }
}
fn continue_to(page: &super::PageRef, id: u32, path: &str, dialog: bool) {
    let callback = page.borrow_mut().downloads.before.remove(&id);
    if let Some(callback) = callback {
        callback.cont(Some(&path.into()), i32::from(dialog));
    }
}
impl OsrRuntime {
    pub fn download_to(&self, page: u64, id: u32, path: &Path) {
        if let Some(page) = self.page(page) {
            continue_to(&page, id, &path.to_string_lossy(), false);
        }
    }
    pub fn download_with_dialog(&self, page: u64, id: u32, suggested_name: &str) {
        if let Some(page) = self.page(page) {
            continue_to(&page, id, suggested_name, true);
        }
    }
    pub fn cancel_download(&self, page: u64, id: u32) {
        let Some(page) = self.page(page) else {
            return;
        };
        let callback = {
            let mut page = page.borrow_mut();
            page.downloads.before.remove(&id);
            let callback = page.downloads.active.get(&id).cloned();
            if callback.is_none() {
                page.downloads.cancelled.insert(id);
            }
            callback
        };
        if let Some(callback) = callback {
            callback.cancel();
        }
    }
}
