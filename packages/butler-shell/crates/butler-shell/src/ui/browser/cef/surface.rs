use butler_cef_host::osr::{OsrCursor, OsrRuntime, Rect};
use gpui::{
    AnyElement, App, Bounds, Context, CursorStyle, ElementId, ElementInputHandler, EntityId,
    FocusHandle, KeyDownEvent, KeyUpEvent, MouseButton, ObjectFit, Pixels, Render, Size,
    SurfaceSource, Window, canvas, div, prelude::*, surface,
};
use std::{
    cell::{Cell, RefCell},
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
    pub(super) views: Vec<EntityId>,
    pub(super) rate: Rc<Cell<u32>>,
    pub(super) last_tick: Option<u64>,
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
            views: Vec::new(),
            rate: Rc::new(Cell::new(60)),
            last_tick: None,
        }
    }
}
impl PageState {
    fn register(&mut self, id: EntityId) {
        if !self.views.contains(&id) {
            self.views.push(id);
        }
    }
    /// Page pixels per element pixel on each axis. The frame fills the element, so it is the
    /// page's size over the element's: the window zoom for a page sized to its element (page
    /// pixels are native logical pixels), only the fit scale for a fixed-size page fitted into it.
    pub(super) fn page_scale(&self, zoom: f32) -> (f32, f32) {
        let ratio = |page: Pixels, element: Pixels| {
            if element > Pixels::ZERO {
                page / element
            } else {
                zoom
            }
        };
        self.geometry.map_or((zoom, zoom), |(page, _)| {
            (
                ratio(page.width, self.bounds.size.width),
                ratio(page.height, self.bounds.size.height),
            )
        })
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
impl Page {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the positive display period converts to a rounded frame rate"
    )]
    fn paced(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<SurfaceSource> {
        let runtime = self.runtime.upgrade()?;
        let vsync = window.frame_vsync();
        if let Some(hz) = vsync
            .filter(|v| v.period_ns > 0)
            .map(|v| (1e9 / v.period_ns as f64).round() as u32)
        {
            self.state.borrow().rate.set(hz);
            runtime.set_frame_rate(self.id, hz);
        }
        let tick = vsync.map_or_else(|| u64::from(gpui::animation_time_ms()), |v| v.at_ns);
        let fresh = self.state.borrow_mut().last_tick.replace(tick) != Some(tick);
        let frame = if fresh {
            runtime.next_frame(self.id)
        } else {
            runtime.frame(self.id)
        };
        if runtime.queued(self.id) {
            let id = cx.entity_id();
            window.on_next_frame(move |_, cx| cx.notify(id));
        }
        frame.and_then(|f| source(f, window))
    }
}
impl Render for Page {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.state.borrow_mut().register(cx.entity_id());
        let entity = cx.entity();
        let focus = self.focus.clone();
        let state = self.state.clone();
        let cursor = match self.state.borrow().cursor {
            OsrCursor::Arrow => CursorStyle::Arrow,
            OsrCursor::PointingHand => CursorStyle::PointingHand,
            OsrCursor::IBeam => CursorStyle::IBeam,
        };
        let frame = self.paced(window, cx);
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
                s.key(&e.keystroke, e.native, false, cx);
                if e.keystroke.key == "tab" {
                    cx.stop_propagation();
                }
            }))
            .on_key_up(cx.listener(|s, e: &KeyUpEvent, _, cx| {
                s.key(&e.keystroke, e.native, true, cx);
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
                .top_0()
                .left_0()
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
/// The hand-off card's live tab picture: the page's current frame, cropped to fill.
pub(super) struct Thumb {
    runtime: Weak<OsrRuntime>,
    id: u64,
    state: Rc<RefCell<PageState>>,
}
impl Render for Thumb {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.state.borrow_mut().register(cx.entity_id());
        div().absolute().top_0().left_0().size_full().children(
            self.runtime
                .upgrade()
                .and_then(|runtime| runtime.frame(self.id))
                .and_then(|f| source(f, window))
                .map(|s| surface(s).object_fit(ObjectFit::Cover).size_full()),
        )
    }
}
pub(super) fn thumbnail(
    id: u64,
    runtime: &Rc<OsrRuntime>,
    state: Rc<RefCell<PageState>>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let thumb = window.use_keyed_state((ElementId::Integer(id), "cef-thumb"), cx, |_, _| Thumb {
        runtime: Rc::downgrade(runtime),
        id,
        state,
    });
    thumb.into_any_element()
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
