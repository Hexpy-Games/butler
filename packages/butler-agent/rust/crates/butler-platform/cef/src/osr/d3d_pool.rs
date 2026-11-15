//! A page's bounded pool of D3D11 shared textures and its two shared fences.
//!
//! The consumer contract (gpui-ce `WindowsSharedTextureFrame`): the producer signals the acquire
//! fence with a frame's value after writing it; the renderer signals the release fence with that
//! value after sampling it. A texture last written for frame K is free again once the release
//! fence's completed value is greater than K.
#![allow(
    unsafe_code,
    reason = "D3D11 shared-resource creation; see SAFETY comments"
)]
use super::OsrError;
use std::{
    os::windows::io::{FromRawHandle, OwnedHandle},
    sync::Arc,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{GENERIC_ALL, HANDLE},
        Graphics::{
            Direct3D11::{
                D3D11_BIND_SHADER_RESOURCE, D3D11_FENCE_FLAG_SHARED, D3D11_RESOURCE_MISC_SHARED,
                D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
                ID3D11Device5, ID3D11Fence, ID3D11Texture2D,
            },
            Dxgi::{
                Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
                DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE, IDXGIResource1,
            },
        },
    },
    core::{Interface, PCWSTR},
};

/// At least two (the contract's minimum); four absorbs a renderer a few frames behind.
const POOL: usize = 4;
/// A release fence that never advances while frames go out means the renderer cannot use it.
const UNUSABLE: Duration = Duration::from_secs(2);

/// One painted frame: NT handles to a premultiplied BGRA texture and the two fences.
/// The handles close when the last clone drops; the shell wraps them for gpui.
#[derive(Clone, Debug)]
pub struct OsrFrame {
    texture: Arc<OwnedHandle>,
    fence: Arc<OwnedHandle>,
    fence_value: u64,
    release: Arc<OwnedHandle>,
    size: (u32, u32),
}
impl OsrFrame {
    /// The shared `DXGI_FORMAT_B8G8R8A8_UNORM` texture (no keyed mutex).
    pub fn texture(&self) -> &Arc<OwnedHandle> {
        &self.texture
    }
    /// The acquire fence, signalled with `fence_value` once the texture is written.
    pub fn fence(&self) -> &Arc<OwnedHandle> {
        &self.fence
    }
    pub fn fence_value(&self) -> u64 {
        self.fence_value
    }
    /// The release fence the renderer signals with `fence_value` after sampling the texture.
    pub fn release(&self) -> &Arc<OwnedHandle> {
        &self.release
    }
    /// Width and height in device pixels.
    pub fn size(&self) -> (u32, u32) {
        self.size
    }
    pub fn get_width(&self) -> usize {
        self.size.0 as usize
    }
    pub fn get_height(&self) -> usize {
        self.size.1 as usize
    }
}

/// A free texture to copy into, the acquire fence to signal, and the frame it becomes.
pub(super) struct Target {
    pub(super) texture: ID3D11Texture2D,
    pub(super) fence: ID3D11Fence,
    pub(super) frame: OsrFrame,
}

struct Slot {
    texture: ID3D11Texture2D,
    handle: Arc<OwnedHandle>,
    /// The fence value of the last frame written here; 0 when never written.
    last: u64,
}
struct Fences {
    acquire: ID3D11Fence,
    acquire_handle: Arc<OwnedHandle>,
    release: ID3D11Fence,
    release_handle: Arc<OwnedHandle>,
    value: u64,
    /// When the first frame of these fences went out.
    first_frame: Option<Instant>,
}

#[derive(Default)]
pub(super) struct FramePool {
    size: (u32, u32),
    slots: Vec<Slot>,
    fences: Option<Fences>,
    /// Frames dropped because every pooled texture was still in the renderer's scene.
    dropped: u64,
    /// The last paint was dropped; `pump` repaints once a texture is free.
    pub(super) repaint_pending: bool,
    /// The pool was recreated for an unusable release fence; only once, so a renderer that is
    /// merely not drawing (minimized window) does not churn textures.
    recreated: bool,
}
impl FramePool {
    /// `None`: all textures are still in use, so this frame is dropped rather than waited for.
    pub(super) fn acquire(
        &mut self,
        device: &ID3D11Device5,
        size: (u32, u32),
    ) -> Result<Option<Target>, OsrError> {
        if self.size != size {
            // The fences stay: their values keep increasing across sizes.
            self.slots.clear();
            self.size = size;
        }
        if self.fences.is_none() {
            self.fences = Some(Fences::new(device)?);
        }
        let free = self.free_slot();
        let fences = self.fences.as_mut().ok_or_else(|| missing("fences"))?;
        let index = match free {
            Some(index) => index,
            None if self.slots.len() < POOL => {
                self.slots.push(Slot::new(device, size)?);
                self.slots.len() - 1
            }
            None => return Ok(self.starve()),
        };
        fences.first_frame.get_or_insert_with(Instant::now);
        fences.value += 1;
        let slot = &mut self.slots[index];
        slot.last = fences.value;
        Ok(Some(Target {
            texture: slot.texture.clone(),
            fence: fences.acquire.clone(),
            frame: OsrFrame {
                texture: slot.handle.clone(),
                fence: fences.acquire_handle.clone(),
                fence_value: fences.value,
                release: fences.release_handle.clone(),
                size,
            },
        }))
    }
    /// The completed value of the release fence; 0 before any fences exist.
    fn released(&self) -> u64 {
        self.fences.as_ref().map_or(0, |fences| {
            // SAFETY: A live fence; reading its completed value has no preconditions.
            unsafe { fences.release.GetCompletedValue() }
        })
    }
    fn free_slot(&self) -> Option<usize> {
        let released = self.released();
        (self.slots.iter()).position(|slot| slot.last == 0 || released > slot.last)
    }
    /// Whether a frame painted now would get a texture.
    pub(super) fn has_room(&self) -> bool {
        self.slots.len() < POOL || self.free_slot().is_some()
    }
    /// A full pool is normal while the renderer is not drawing; the page repaints once a
    /// texture is released. Only a release fence that never advanced is recreated, once.
    fn starve(&mut self) -> Option<Target> {
        self.dropped += 1;
        if self.dropped == 1 {
            eprintln!("CEF OSR frame dropped: every pooled texture is still shown");
        }
        let unusable = self.released() == 0
            && (self.fences.as_ref())
                .and_then(|fences| fences.first_frame)
                .is_some_and(|first| first.elapsed() >= UNUSABLE);
        if unusable && !self.recreated {
            // New textures and fences (new handles), per the contract's fallback.
            eprintln!("CEF OSR release fence never advanced; recreating the frame pool once");
            self.slots.clear();
            self.fences = None;
            self.recreated = true;
        }
        None
    }
}

impl Slot {
    fn new(device: &ID3D11Device5, (width, height): (u32, u32)) -> Result<Self, OsrError> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0.cast_unsigned(),
            CPUAccessFlags: 0,
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE)
                .0
                .cast_unsigned(),
        };
        let mut texture = None;
        // SAFETY: `desc` is a valid single-texture description and outlives the call.
        unsafe { device.CreateTexture2D(&raw const desc, None, Some(&raw mut texture)) }
            .map_err(failed("create pooled texture"))?;
        let texture: ID3D11Texture2D = texture.ok_or_else(|| missing("pooled texture"))?;
        let resource: IDXGIResource1 = texture.cast().map_err(failed("IDXGIResource1"))?;
        let access = (DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE).0;
        // SAFETY: An unnamed handle with default security for a live NT-shareable resource.
        let handle = unsafe { resource.CreateSharedHandle(None, access, PCWSTR::null()) }
            .map_err(failed("share pooled texture"))?;
        Ok(Self {
            texture,
            handle: Arc::new(owned(handle)?),
            last: 0,
        })
    }
}

impl Fences {
    fn new(device: &ID3D11Device5) -> Result<Self, OsrError> {
        let (acquire, acquire_handle) = shared_fence(device)?;
        let (release, release_handle) = shared_fence(device)?;
        Ok(Self {
            acquire,
            acquire_handle,
            release,
            release_handle,
            value: 0,
            first_frame: None,
        })
    }
}
fn shared_fence(device: &ID3D11Device5) -> Result<(ID3D11Fence, Arc<OwnedHandle>), OsrError> {
    let mut fence: Option<ID3D11Fence> = None;
    // SAFETY: `fence` is a valid out slot for the requested interface.
    unsafe { device.CreateFence(0, D3D11_FENCE_FLAG_SHARED, &raw mut fence) }
        .map_err(failed("create shared fence"))?;
    let fence = fence.ok_or_else(|| missing("fence"))?;
    // SAFETY: An unnamed handle with default security for a live shareable fence.
    let handle = unsafe { fence.CreateSharedHandle(None, GENERIC_ALL.0, PCWSTR::null()) }
        .map_err(failed("share fence"))?;
    Ok((fence, Arc::new(owned(handle)?)))
}

/// Take ownership of a handle a `CreateSharedHandle` call just returned.
fn owned(handle: HANDLE) -> Result<OwnedHandle, OsrError> {
    if handle.is_invalid() {
        return Err(missing("shared handle"));
    }
    // SAFETY: CreateSharedHandle returns a new NT handle that the caller alone must close.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
}
pub(super) fn failed(what: &'static str) -> impl Fn(windows::core::Error) -> OsrError {
    move |error| OsrError(format!("{what}: {error}"))
}
pub(super) fn missing(what: &str) -> OsrError {
    OsrError(format!("missing {what}"))
}
