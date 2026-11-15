use butler_cef_host::osr::{OsrCursor, OsrRuntime, Rect};
use gpui::{
    AnyElement, App, Bounds, Context, CursorStyle, ElementId, ElementInputHandler, FocusHandle,
    KeyDownEvent, KeyUpEvent, MouseButton, ObjectFit, Pixels, Render, Size, SurfaceSource, Window,
    canvas, div, prelude::*, surface,
};
use std::{
    cell::RefCell,
    ops::Range,
    rc::{Rc, Weak},
};

pub(super) struct PageState {
    pub(super) bounds: Bounds<Pixels>,
    pub(super) geometry: Option<(Size<Pixels>, f32)>,
    pub(super) cursor: OsrCursor,
    pub(super) ime_bounds: Vec<Rect>,
}
impl Default for PageState {
    fn default() -> Self {
        Self {
            bounds: Bounds::default(),
            geometry: None,
            cursor: OsrCursor::Arrow,
            ime_bounds: Vec::new(),
        }
    }
}
pub(super) struct Page {
    pub(super) runtime: Weak<OsrRuntime>,
    pub(super) id: u64,
    pub(super) focus: FocusHandle,
    pub(super) state: Rc<RefCell<PageState>>,
}
pub(super) fn element(
    id: u64,
    runtime: &Rc<OsrRuntime>,
    state: Rc<RefCell<PageState>>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let page = window.use_keyed_state((ElementId::Integer(id), "cef-page"), cx, |_, cx| Page {
        runtime: Rc::downgrade(runtime),
        id,
        focus: cx.focus_handle(),
        state,
    });
    page.into_any_element()
}
impl Render for Page {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        let focus = self.focus.clone();
        let state = self.state.clone();
        let cursor = match self.state.borrow().cursor {
            OsrCursor::Arrow => CursorStyle::Arrow,
            OsrCursor::PointingHand => CursorStyle::PointingHand,
            OsrCursor::IBeam => CursorStyle::IBeam,
        };
        let frame = (self.runtime.upgrade())
            .and_then(|r| r.frame(self.id))
            .and_then(source);
        let page = div()
            .id("cef-surface")
            .relative()
            .size_full()
            .track_focus(&self.focus)
            .cursor(cursor)
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_mouse_exit(cx.listener(Self::mouse_exit))
            .on_scroll_wheel(cx.listener(Self::wheel))
            .on_key_down(cx.listener(|s, e: &KeyDownEvent, _, _| {
                s.key(&e.keystroke, e.native, false);
            }))
            .on_key_up(cx.listener(|s, e: &KeyUpEvent, _, _| {
                s.key(&e.keystroke, e.native, true);
            }));
        let page = [MouseButton::Left, MouseButton::Middle, MouseButton::Right]
            .into_iter()
            .fold(page, |page, button| {
                page.on_mouse_down(button, cx.listener(Self::mouse_down))
                    .on_mouse_up(button, cx.listener(Self::mouse_up))
                    .on_mouse_up_out(button, cx.listener(Self::mouse_up))
            });
        page.children(frame.map(|frame| {
            surface(frame)
                .object_fit(ObjectFit::Fill)
                .size_full()
                .absolute()
        }))
        .child(
            canvas(
                move |bounds, _, _| {
                    state.borrow_mut().bounds = bounds;
                    bounds
                },
                move |_, bounds, window, cx| {
                    window.handle_input(
                        &focus,
                        ElementInputHandler::new(bounds, entity.clone()),
                        cx,
                    );
                },
            )
            .size_full(),
        )
    }
}
/// The macOS frame: an IOSurface-backed CoreVideo buffer.
#[cfg(target_os = "macos")]
#[expect(
    clippy::unnecessary_wraps,
    reason = "one signature with the fallible Windows frame conversion"
)]
fn source(frame: impl Into<SurfaceSource>) -> Option<SurfaceSource> {
    Some(frame.into())
}
/// The Windows frame: a pooled D3D11 shared texture with its acquire and release fences. The
/// runtime raises the fence value per frame, as gpui's damage tracking requires.
#[cfg(windows)]
#[expect(
    clippy::needless_pass_by_value,
    reason = "the frame is the runtime's clone; one signature with the macOS conversion"
)]
fn source(frame: butler_cef_host::osr::OsrFrame) -> Option<SurfaceSource> {
    let (width, height) = frame.size();
    let size = gpui::size(
        gpui::DevicePixels(i32::try_from(width).ok()?),
        gpui::DevicePixels(i32::try_from(height).ok()?),
    );
    Some(SurfaceSource::WindowsSharedTexture(
        gpui::WindowsSharedTextureFrame::new(
            frame.texture().clone(),
            frame.fence().clone(),
            frame.fence_value(),
            frame.release().clone(),
            size,
        ),
    ))
}
pub(super) fn range(range: Range<u32>) -> Range<usize> {
    usize::try_from(range.start).unwrap_or(usize::MAX)
        ..usize::try_from(range.end).unwrap_or(usize::MAX)
}
