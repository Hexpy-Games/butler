#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
use super::{
    OsrError, OsrEvent,
    gpu::{GpuCopy, wrap_accelerated},
    state::{Events, Page, PageRef},
};
use cef::*;

cef::wrap_render_handler! {
    pub(super) struct Paint { shared: PageRef, events: Events }
    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect {
                let p = self.shared.borrow();
                rect.width = i32::try_from(p.size.0).unwrap_or(i32::MAX).max(1);
                rect.height = i32::try_from(p.size.1).unwrap_or(i32::MAX).max(1);
            }
        }
        fn screen_info(&self, _browser: Option<&mut Browser>, info: Option<&mut ScreenInfo>) -> i32 {
            if let Some(info) = info { info.device_scale_factor = self.shared.borrow().scale.max(1.); 1 } else { 0 }
        }
        fn on_accelerated_paint(&self, _browser: Option<&mut Browser>, kind: PaintElementType,
            _dirty: Option<&[Rect]>, info: Option<&AcceleratedPaintInfo>) {
            // Browser popups are cancelled by Life; VIEW is the page's surface.
            if kind != PaintElementType::VIEW { return; }
            let accepted = {
                let mut p = self.shared.borrow_mut();
                if !p.visible || p.closing { return; }
                let Some(info) = info else { return; };
                match copy_frame(&mut p, info) {
                    Ok(()) => true,
                    Err(error) => {
                        if !p.paint_error_logged {
                            eprintln!("CEF OSR paint skipped: {error}");
                            p.paint_error_logged = true;
                        }
                        false
                    }
                }
            };
            if accepted { self.events.emit(OsrEvent::Frame); }
        }
        fn on_ime_composition_range_changed(&self, _browser: Option<&mut Browser>,
            _range: Option<&Range>, bounds: Option<&[Rect]>) {
            self.events.emit(OsrEvent::ImeBounds(bounds.unwrap_or_default().iter().map(super::Rect::from).collect()));
        }
        fn on_text_selection_changed(&self, _browser: Option<&mut Browser>, _text: Option<&CefString>, range: Option<&Range>) {
            if let Some(range) = range { self.shared.borrow_mut().ime.document_selection = range.from..range.to; }
        }
    }
}
fn copy_frame(page: &mut Page, info: &AcceleratedPaintInfo) -> Result<(), OsrError> {
    let source = wrap_accelerated(info)?;
    if page.gpu.is_none() {
        page.gpu = Some(GpuCopy::new()?);
    }
    let frame = page.pool.acquire(source.get_width(), source.get_height())?;
    let gpu = page
        .gpu
        .as_ref()
        .ok_or_else(|| OsrError("missing GPU copier".into()))?;
    gpu.copy(&source, &frame)?;
    page.frame = Some(frame);
    Ok(())
}
