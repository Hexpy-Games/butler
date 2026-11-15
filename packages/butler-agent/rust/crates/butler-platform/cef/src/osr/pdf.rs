#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::{OsrEvent, OsrRuntime, PdfSettings, state::Events};
use cef::*;
use std::path::Path;

impl OsrRuntime {
    pub fn print_to_pdf(&self, page: u64, path: &Path, settings: PdfSettings) {
        let events = Events {
            page,
            sink: self.sink.clone(),
        };
        let Some(host) = self.host(page) else {
            events.emit(OsrEvent::PdfDone { ok: false });
            return;
        };
        host.print_to_pdf(
            Some(&path.to_string_lossy().as_ref().into()),
            Some(&PdfPrintSettings {
                print_background: i32::from(settings.print_background),
                prefer_css_page_size: i32::from(settings.prefer_css_page_size),
                scale: 1.,
                paper_width: 8.5,
                paper_height: 11.,
                margin_type: PdfPrintMarginType::CUSTOM,
                margin_top: 0.4,
                margin_bottom: 0.4,
                margin_left: 0.4,
                margin_right: 0.4,
                ..Default::default()
            }),
            Some(&mut Printed::new(events)),
        );
    }
}
wrap_pdf_print_callback! {
    struct Printed { events: Events }
    impl PdfPrintCallback {
        fn on_pdf_print_finished(&self, _path: Option<&CefString>, ok: i32) {
            self.events.emit(OsrEvent::PdfDone { ok: ok != 0 });
        }
    }
}
