//! Audited D3D11 boundary of the Windows OSR paint path.
//!
//! CEF lends a shared texture (an NT handle) that is valid only during `on_accelerated_paint`.
//! The runtime opens it on its own device, copies it into a pooled texture (d3d_pool.rs),
//! signals the frame's acquire fence, flushes, and waits for the copy before returning, since CEF
//! reuses the source texture after the callback.
//!
//! Adapter: CEF does not expose its GPU process's adapter LUID, so the device uses the default
//! hardware adapter, as CEF's GPU process does. On hybrid-GPU machines a per-app GPU preference
//! (Windows graphics settings) can put the shell and `butler_cef_host.exe` on different adapters;
//! opening CEF's texture then fails and paint is skipped with a logged error.
#![allow(unsafe_code, reason = "D3D11 interop; see SAFETY comments")]
use super::{
    OsrError, OsrFrame,
    d3d_pool::{FramePool, Target, failed, missing},
    state::Page,
};
use cef::{ImplBrowser, ImplBrowserHost};
use std::{
    cell::RefCell,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{HANDLE, HMODULE, WAIT_OBJECT_0},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1},
            Direct3D11::{
                D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
                D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device5, ID3D11DeviceContext4,
                ID3D11Fence, ID3D11Texture2D,
            },
            Dxgi::{
                Common::{
                    DXGI_FORMAT_B8G8R8A8_TYPELESS, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
                },
                IDXGIAdapter,
            },
        },
        System::Threading::{CreateEventW, WaitForSingleObject},
    },
    core::{Interface, PCWSTR},
};

/// Bounds the wait for one frame copy, which takes well under a millisecond.
const COPY_TIMEOUT: Duration = Duration::from_secs(1);

thread_local! {
    /// One device for every page on the UI thread; pages share it instead of creating their own.
    static DEVICE: RefCell<Option<Device>> = const { RefCell::new(None) };
}

#[derive(Clone)]
struct Device {
    device: ID3D11Device5,
    context: ID3D11DeviceContext4,
}
fn create_device() -> Result<Device, OsrError> {
    let (mut device, mut context) = (None, None);
    // SAFETY: Out slots are valid; a null adapter selects the default hardware adapter.
    unsafe {
        D3D11CreateDevice(
            None::<&IDXGIAdapter>,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&raw mut device),
            None,
            Some(&raw mut context),
        )
    }
    .map_err(failed("create D3D11 device"))?;
    let device = device.ok_or_else(|| missing("D3D11 device"))?;
    let context = context.ok_or_else(|| missing("D3D11 context"))?;
    Ok(Device {
        device: device.cast().map_err(failed("ID3D11Device5"))?,
        context: context.cast().map_err(failed("ID3D11DeviceContext4"))?,
    })
}

/// Drop the cached device; the runtime calls this once CEF has shut down.
pub(super) fn release_device() {
    DEVICE.with_borrow_mut(Option::take);
}

pub(super) struct GpuCopy {
    device: Device,
    /// Signalled when a copy's acquire-fence value completes.
    done: OwnedHandle,
    /// A copy whose wait timed out; paints are dropped until its fence value completes, so a
    /// hung GPU does not block the UI thread for every paint.
    stalled: RefCell<Option<(ID3D11Fence, u64)>>,
}
impl GpuCopy {
    pub(super) fn new() -> Result<Self, OsrError> {
        let device = DEVICE.with_borrow_mut(|cached| {
            if let Some(device) = cached.as_ref().filter(|d| {
                // SAFETY: Querying a live device's removal state has no preconditions.
                unsafe { d.device.GetDeviceRemovedReason().is_ok() }
            }) {
                return Ok(device.clone());
            }
            let device = create_device()?;
            *cached = Some(device.clone());
            Ok::<_, OsrError>(device)
        })?;
        // SAFETY: An unnamed auto-reset event with default security.
        let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
            .map_err(failed("create copy event"))?;
        // SAFETY: CreateEventW returned a new handle that this struct alone closes.
        let done = unsafe { OwnedHandle::from_raw_handle(event.0) };
        Ok(Self {
            device,
            done,
            stalled: RefCell::default(),
        })
    }
    /// Whether an earlier timed-out copy is still running on the GPU.
    fn busy(&self) -> bool {
        let mut stalled = self.stalled.borrow_mut();
        // SAFETY: Reading a live fence's completed value has no preconditions.
        let running =
            (stalled.as_ref()).is_some_and(|(f, v)| unsafe { f.GetCompletedValue() } < *v);
        if !running {
            *stalled = None;
        }
        running
    }
    fn removed(&self) -> bool {
        // SAFETY: Querying a live device's removal state has no preconditions.
        unsafe { self.device.device.GetDeviceRemovedReason().is_err() }
    }
    fn open(&self, handle: HANDLE) -> Result<ID3D11Texture2D, OsrError> {
        // SAFETY: CEF keeps the NT handle open for this paint callback; opening adds a reference.
        unsafe { self.device.device.OpenSharedResource1(handle) }
            .map_err(failed("open CEF shared texture"))
    }
    fn copy(&self, source: &ID3D11Texture2D, target: &Target) -> Result<(), OsrError> {
        let context = &self.device.context;
        let value = target.frame.fence_value();
        // SAFETY: Both textures belong to this device and have equal size, mips and format
        // group; the fence belongs to this device and outlives the queued signal.
        unsafe {
            context.CopyResource(&target.texture, source);
            context.Signal(&target.fence, value)
        }
        .map_err(failed("signal frame fence"))?;
        let result = wait(context, &target.fence, value, &self.done);
        if result.is_err() {
            *self.stalled.borrow_mut() = Some((target.fence.clone(), value));
        }
        result
    }
}
/// Flush and block until `fence` reaches `value`.
fn wait(
    context: &ID3D11DeviceContext4,
    fence: &ID3D11Fence,
    value: u64,
    event: &OwnedHandle,
) -> Result<(), OsrError> {
    let event = HANDLE(event.as_raw_handle());
    // SAFETY: The fence and the event are live for the whole wait.
    unsafe {
        fence
            .SetEventOnCompletion(value, event)
            .map_err(failed("wait for frame copy"))?;
        context.Flush();
    }
    let deadline = Instant::now() + COPY_TIMEOUT;
    // The fence decides: a signal left by an earlier timed-out wait can wake this one early.
    // SAFETY: Reading a live fence's completed value has no preconditions.
    while unsafe { fence.GetCompletedValue() } < value {
        let left = deadline.saturating_duration_since(Instant::now());
        let millis = u32::try_from(left.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: The event handle is live for the whole wait.
        if millis == 0 || unsafe { WaitForSingleObject(event, millis) } != WAIT_OBJECT_0 {
            return Err(OsrError("frame copy did not complete".into()));
        }
    }
    Ok(())
}

pub(super) fn copy_frame(
    page: &mut Page,
    info: &cef::AcceleratedPaintInfo,
) -> Result<bool, OsrError> {
    if info.shared_texture_handle.is_null() {
        return Err(missing("accelerated shared texture"));
    }
    if *info.format.as_ref() != cef::sys::cef_color_type_t::CEF_COLOR_TYPE_BGRA_8888 {
        return Err(OsrError("accelerated texture is not BGRA".into()));
    }
    // Textures and fences live on the device; a removed device takes them along.
    if page.gpu.as_ref().is_some_and(GpuCopy::removed) {
        page.gpu = None;
        page.pool = FramePool::default();
    }
    if page.gpu.is_none() {
        // While a reset device cannot be recreated yet, the pump retries this paint.
        page.pool.repaint_pending = true;
        page.gpu = Some(GpuCopy::new()?);
    }
    let gpu = page.gpu.as_ref().ok_or_else(|| missing("GPU copier"))?;
    if gpu.busy() {
        page.pool.repaint_pending = true;
        return Ok(false);
    }
    let source = gpu.open(HANDLE(info.shared_texture_handle))?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: `desc` is a valid out parameter.
    unsafe { source.GetDesc(&raw mut desc) };
    if !matches!(
        desc.Format,
        DXGI_FORMAT_B8G8R8A8_UNORM | DXGI_FORMAT_B8G8R8A8_TYPELESS
    ) || desc.SampleDesc.Count != 1
        || desc.ArraySize != 1
        || desc.MipLevels != 1
    {
        return Err(OsrError("unexpected CEF shared texture layout".into()));
    }
    let Some(target) = page
        .pool
        .acquire(&gpu.device.device, (desc.Width, desc.Height))?
    else {
        page.pool.repaint_pending = true;
        return Ok(false);
    };
    if let Err(error) = gpu.copy(&source, &target) {
        page.pool.repaint_pending = true;
        return Err(error);
    }
    // A removed device reports every fence value complete; its texture holds nothing.
    if gpu.removed() {
        page.pool.repaint_pending = true;
        return Ok(false);
    }
    page.pool.repaint_pending = false;
    page.frame = Some(target.frame);
    Ok(true)
}

impl super::OsrRuntime {
    /// Called from `pump`: repaint visible pages whose last paint was dropped, once a pooled
    /// texture is free again (or the device must be recreated).
    pub(super) fn repaint_dropped(&self) {
        let pages: Vec<_> = self.state.pages.borrow().values().cloned().collect();
        for page in pages {
            let browser = {
                let mut p = page.borrow_mut();
                let gpu_ready = (p.gpu.as_ref()).is_none_or(|g| g.removed() || !g.busy());
                if !p.pool.repaint_pending || !p.visible || p.closing || !gpu_ready {
                    continue;
                }
                if !p.pool.has_room() && !p.gpu.as_ref().is_some_and(GpuCopy::removed) {
                    continue;
                }
                p.pool.repaint_pending = false;
                p.browser.clone()
            };
            if let Some(host) = browser.and_then(|b| b.host()) {
                host.invalidate(cef::PaintElementType::VIEW);
            }
        }
    }
}

/// Read one BGRA pixel of a frame on a separate device, as a consumer would: open the shared
/// texture and fences, wait for the frame's value, copy the pixel to a staging texture, release.
pub fn read_bgra_pixel(frame: &OsrFrame, x: usize, y: usize) -> Result<[u8; 4], OsrError> {
    let (width, height) = frame.size();
    let (Ok(x), Ok(y)) = (u32::try_from(x), u32::try_from(y)) else {
        return Err(OsrError("pixel outside the frame".into()));
    };
    if x >= width || y >= height {
        return Err(OsrError("pixel outside the frame".into()));
    }
    let Device { device, context } = create_device()?;
    let staging = staging_pixel(&device)?;
    let (mut fence, mut release): (Option<ID3D11Fence>, Option<ID3D11Fence>) = (None, None);
    let region = D3D11_BOX {
        left: x,
        top: y,
        front: 0,
        right: x + 1,
        bottom: y + 1,
        back: 1,
    };
    // SAFETY: The frame's handles stay open while `frame` is borrowed; out slots are valid.
    let texture: ID3D11Texture2D = unsafe {
        device
            .OpenSharedFence(HANDLE(frame.fence().as_raw_handle()), &raw mut fence)
            .map_err(failed("open frame fence"))?;
        device
            .OpenSharedFence(HANDLE(frame.release().as_raw_handle()), &raw mut release)
            .map_err(failed("open release fence"))?;
        device.OpenSharedResource1(HANDLE(frame.texture().as_raw_handle()))
    }
    .map_err(failed("open frame texture"))?;
    let fence = fence.ok_or_else(|| missing("frame fence"))?;
    let release = release.ok_or_else(|| missing("release fence"))?;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // SAFETY: Live resources of this device; Map blocks until the GPU copy is done, and the
    // mapped row holds at least the one 4-byte pixel until Unmap.
    unsafe {
        context
            .Wait(&fence, frame.fence_value())
            .map_err(failed("wait for frame"))?;
        context.CopySubresourceRegion(&staging, 0, 0, 0, 0, &texture, 0, Some(&raw const region));
        context
            .Signal(&release, frame.fence_value())
            .map_err(failed("release frame"))?;
        context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&raw mut mapped))
            .map_err(failed("map staging pixel"))?;
        let pixel = std::ptr::read_unaligned(mapped.pData.cast::<[u8; 4]>());
        context.Unmap(&staging, 0);
        Ok(pixel)
    }
}
fn staging_pixel(device: &ID3D11Device5) -> Result<ID3D11Texture2D, OsrError> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: 1,
        Height: 1,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0.cast_unsigned(),
        MiscFlags: 0,
    };
    let mut texture = None;
    // SAFETY: `desc` describes one CPU-readable staging pixel and outlives the call.
    unsafe { device.CreateTexture2D(&raw const desc, None, Some(&raw mut texture)) }
        .map_err(failed("create staging texture"))?;
    texture.ok_or_else(|| missing("staging texture"))
}
