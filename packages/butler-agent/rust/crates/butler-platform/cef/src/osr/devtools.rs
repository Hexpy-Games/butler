//! Per-page, UI-thread DevTools messages; CEF owns the observer until registration is dropped.
#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::{
    OsrError, OsrEvent, OsrRuntime, RAW_ID_BASE,
    state::{Events, Page, PageRef},
};
use cef::*;
use std::{cell::RefCell, rc::Weak};

impl OsrRuntime {
    pub fn devtools(&self, page: u64, method: &str, params_json: &str) -> Result<i32, OsrError> {
        let (shared, host) = self.devtools_page(page)?;
        let mut state = shared.borrow_mut();
        self.ensure_observer(page, &shared, &host, &mut state)?;
        state.next_devtools = state
            .next_devtools
            .checked_add(1)
            .filter(|id| *id < RAW_ID_BASE)
            .ok_or_else(|| OsrError("DevTools request ids exhausted".into()))?;
        let id = state.next_devtools;
        // Method names come from the host protocol, params are serialized JSON from the shell.
        let message = format!(r#"{{"id":{id},"method":"{method}","params":{params_json}}}"#);
        drop(state);
        if host.send_dev_tools_message(Some(message.as_bytes())) != 1 {
            return Err(OsrError("DevTools message rejected".into()));
        }
        Ok(id)
    }

    /// Sends a complete CDP message unchanged; every raw page message then arrives as
    /// `OsrEvent::DevToolsRaw` until `devtools_raw_end`. Callers use ids at or above `RAW_ID_BASE`.
    pub fn devtools_raw(&self, page: u64, message: &[u8]) -> Result<(), OsrError> {
        let (shared, host) = self.devtools_page(page)?;
        let mut state = shared.borrow_mut();
        self.ensure_observer(page, &shared, &host, &mut state)?;
        state.devtools_raw = true;
        drop(state);
        if host.send_dev_tools_message(Some(message)) != 1 {
            return Err(OsrError("DevTools message rejected".into()));
        }
        Ok(())
    }

    pub fn devtools_raw_end(&self, page: u64) {
        if let Some(shared) = self.page(page) {
            shared.borrow_mut().devtools_raw = false;
        }
    }

    fn devtools_page(&self, page: u64) -> Result<(PageRef, BrowserHost), OsrError> {
        let shared = self
            .page(page)
            .ok_or_else(|| OsrError("unknown page".into()))?;
        let host = self
            .host(page)
            .ok_or_else(|| OsrError("page has no host".into()))?;
        Ok((shared, host))
    }

    fn ensure_observer(
        &self,
        page: u64,
        shared: &PageRef,
        host: &BrowserHost,
        state: &mut Page,
    ) -> Result<(), OsrError> {
        if state.devtools.is_none() {
            let mut observer = Observer::new(
                Events {
                    page,
                    sink: self.sink.clone(),
                },
                std::rc::Rc::downgrade(shared),
            );
            state.devtools = host.add_dev_tools_message_observer(Some(&mut observer));
            if state.devtools.is_none() {
                return Err(OsrError("DevTools observer registration failed".into()));
            }
        }
        Ok(())
    }
}

cef::wrap_dev_tools_message_observer! {
    struct Observer { events: Events, shared: Weak<RefCell<Page>> }
    impl DevToolsMessageObserver {
        fn on_dev_tools_message(&self, _browser: Option<&mut Browser>, message: Option<&[u8]>) -> i32 {
            let raw = self.shared.upgrade().is_some_and(|page| page.borrow().devtools_raw);
            if raw {
                self.events.emit(OsrEvent::DevToolsRaw { message: message.unwrap_or_default().to_vec() });
            }
            0
        }
        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, message_id: i32,
            success: i32, result: Option<&[u8]>) {
            let body = String::from_utf8_lossy(result.unwrap_or(b"null"));
            let key = if success == 1 { "result" } else { "error" };
            self.events.emit(OsrEvent::DevTools {
                id: message_id, result_json: format!(r#"{{"{key}":{body}}}"#),
            });
        }
        fn on_dev_tools_event(&self, _browser: Option<&mut Browser>, method: Option<&CefString>,
            params: Option<&[u8]>) {
            self.events.emit(OsrEvent::DevToolsEvent {
                method: method.map(ToString::to_string).unwrap_or_default(),
                params_json: String::from_utf8_lossy(params.unwrap_or(b"{} ")).into_owned(),
            });
        }
    }
}
