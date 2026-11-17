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
    pub(super) tab: Option<super::TabId>,
    pub(super) devtools: super::devtools::Requests,
    pub(super) bounds: Bounds<Pixels>,
    pub(super) geometry: Option<(Size<Pixels>, f32)>,
    pub(super) cursor: OsrCursor,
    pub(super) last_input: Rc<std::cell::Cell<Option<std::time::Instant>>>,
    pub(super) ime_bounds: Vec<Rect>,
}
impl Default for PageState {
    fn default() -> Self {
        Self {
            tab: None,
            devtools: Default::default(),
            bounds: Bounds::default(),
            geometry: None,
            cursor: OsrCursor::Arrow,
            last_input: Rc::default(),
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .and_then(|frame| source(frame, window));
        let page = div()
            .id("cef-surface")
            .relative()
            .size_full()
            .track_focus(&self.focus)
            .cursor(cursor)
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_mouse_exit(cx.listener(Self::mouse_exit))
            .on_scroll_wheel(cx.listener(Self::wheel))
            // The page moves its own focus on Tab: the shell's Tab navigation must not take focus
            // off it. Other keys go on to the text input that types into the page.
            .on_key_down(cx.listener(|s, e: &KeyDownEvent, _, cx| {
                s.key(&e.keystroke, e.native, false);
                if e.keystroke.key == "tab" {
                    cx.stop_propagation();
                }
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
fn source(frame: impl Into<SurfaceSource>, _: &Window) -> Option<SurfaceSource> {
    Some(frame.into())
}
/// The Windows frame: a pooled D3D11 shared texture with its acquire and release fences. The
/// runtime raises the fence value per frame, as gpui's damage tracking requires.
#[cfg(windows)]
#[expect(
    clippy::needless_pass_by_value,
    reason = "the frame is the runtime's clone; one signature with the macOS conversion"
)]
fn source(frame: butler_cef_host::osr::OsrFrame, _: &Window) -> Option<SurfaceSource> {
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
/// The Linux frame: CPU pixels, uploaded to a texture on gpui's device. Only the damaged area is
/// uploaded; the texture lives in the frame's consumer slot, so a resized or hidden page drops it.
#[cfg(target_os = "linux")]
#[expect(
    clippy::needless_pass_by_value,
    reason = "the frame is the runtime's clone; one signature with the other platforms' conversions"
)]
fn source(frame: butler_cef_host::osr::OsrFrame, window: &Window) -> Option<SurfaceSource> {
    use gpui_wgpu::wgpu;
    use std::{any::Any, sync::Arc};
    struct Upload {
        device: Arc<wgpu::Device>,
        texture: wgpu::Texture,
        handle: Arc<dyn Any + Send + Sync>,
    }
    // gpui's `gpu_context` panics while the renderer recovers a lost device; headless reports `None`.
    if window.gpu_device_lost() == Some(true) {
        return None;
    }
    let (device, queue) = *window
        .gpu_context()?
        .downcast::<(Arc<wgpu::Device>, Arc<wgpu::Queue>)>()
        .ok()?;
    let kept = (frame.consumer().take())
        .and_then(|slot| slot.downcast::<Upload>().ok())
        .filter(|upload| Arc::ptr_eq(&upload.device, &device));
    let damage = frame.take_damage();
    let (width, height) = frame.size();
    let size = gpui::size(
        gpui::DevicePixels(i32::try_from(width).ok()?),
        gpui::DevicePixels(i32::try_from(height).ok()?),
    );
    let extent = |width, height| wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    let (mut upload, area) = match kept {
        Some(upload) => (*upload, damage.map(|d| [d.x, d.y, d.width, d.height])),
        None => {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("cef page"),
                size: extent(width, height),
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Bgra8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let upload = Upload {
                device: device.clone(),
                handle: Arc::new(texture.clone()),
                texture,
            };
            (upload, Some([0, 0, size.width.0, size.height.0]))
        }
    };
    if let Some(area) = area {
        let [Some(x), Some(y), Some(area_width), Some(area_height)] =
            area.map(|v| u32::try_from(v).ok())
        else {
            return None;
        };
        let start = (y as usize * width as usize + x as usize) * 4;
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &upload.texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            frame.pixels().get(start..)?,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width.checked_mul(4)?),
                rows_per_image: None,
            },
            extent(area_width, area_height),
        );
        upload.handle = Arc::new(upload.texture.clone());
    }
    let texture = upload.handle.clone();
    *frame.consumer().borrow_mut() = Some(Box::new(upload));
    Some(SurfaceSource::Texture { texture, size })
}
pub(super) fn range(range: Range<u32>) -> Range<usize> {
    usize::try_from(range.start).unwrap_or(usize::MAX)
        ..usize::try_from(range.end).unwrap_or(usize::MAX)
}
