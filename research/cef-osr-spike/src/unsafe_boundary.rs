#![allow(unsafe_code)]
// Foreign frame lifetimes and CoreVideo addresses cannot be expressed by these safe APIs.
use core_foundation::base::TCFType;
use core_video::pixel_buffer::{CVPixelBuffer, kCVPixelFormatType_32BGRA};
use core_video::{
    metal_texture::{CVMetalTexture, CVMetalTextureGetTexture},
    metal_texture_cache::CVMetalTextureCache,
};
use foreign_types::ForeignTypeRef;

#[link(name = "IOSurface", kind = "framework")]
unsafe extern "C" {
    fn IOSurfaceGetID(surface: *const std::ffi::c_void) -> u32;
}

pub fn copy_paint(
    pool: &mut crate::frame_pool::FramePool,
    buffer: *const u8,
    width: usize,
    height: usize,
    source_stride: usize,
) -> Option<CVPixelBuffer> {
    if buffer.is_null() || width == 0 || height == 0 {
        return None;
    }
    let row_bytes = width.checked_mul(4)?;
    if source_stride < row_bytes {
        return None;
    }
    source_stride.checked_mul(height)?;
    let frame = pool.acquire(width, height);
    if frame.lock_base_address(0) != 0 {
        return None;
    }
    let stride = frame.get_bytes_per_row();
    assert!(stride >= row_bytes && frame.get_data_size() >= stride.checked_mul(height)?);
    // SAFETY: callers supply CEF callback bytes, or a locked IOSurface CVPixelBuffer.
    // Both cover source_stride*height; the exclusively acquired locked destination is disjoint and sized above.
    unsafe {
        let target = frame.get_base_address().cast::<u8>();
        assert!(!target.is_null());
        for row in 0..height {
            std::ptr::copy_nonoverlapping(
                buffer.add(row * source_stride),
                target.add(row * stride),
                row_bytes,
            );
        }
    }
    assert_eq!(frame.unlock_base_address(0), 0);
    Some(frame)
}
// One Metal queue and texture cache for all frame copies.
pub struct GpuCopy {
    queue: metal::CommandQueue,
    cache: CVMetalTextureCache,
}
impl GpuCopy {
    pub fn new() -> Self {
        let device = metal::Device::system_default().expect("Metal device");
        Self {
            queue: device.new_command_queue(),
            cache: CVMetalTextureCache::new(None, device, None).expect("Metal texture cache"),
        }
    }
    fn texture(&self, buffer: &CVPixelBuffer) -> CVMetalTexture {
        self.cache
            .create_texture_from_image(
                buffer.as_concrete_TypeRef(),
                None,
                metal::MTLPixelFormat::BGRA8Unorm,
                buffer.get_width(),
                buffer.get_height(),
                0,
            )
            .expect("Frame texture")
    }
    pub fn copy(&self, source: &CVPixelBuffer, target: &CVPixelBuffer) {
        objc::rc::autoreleasepool(|| {
            let (from, to) = (self.texture(source), self.texture(target));
            // SAFETY: each CVMetalTexture above owns its MTLTexture and outlives this blit.
            let (from_texture, to_texture) = unsafe {
                (
                    metal::TextureRef::from_ptr(
                        CVMetalTextureGetTexture(from.as_concrete_TypeRef()) as *mut _,
                    ),
                    metal::TextureRef::from_ptr(
                        CVMetalTextureGetTexture(to.as_concrete_TypeRef()) as *mut _
                    ),
                )
            };
            let origin = metal::MTLOrigin { x: 0, y: 0, z: 0 };
            let size = metal::MTLSize {
                width: source.get_width() as u64,
                height: source.get_height() as u64,
                depth: 1,
            };
            let command = self.queue.new_command_buffer();
            let blit = command.new_blit_command_encoder();
            blit.copy_from_texture(from_texture, 0, 0, origin, size, to_texture, 0, 0, origin);
            blit.end_encoding();
            command.commit();
            // CEF reclaims its surface when the paint callback returns, so the copy must finish first.
            command.wait_until_completed();
        });
        self.cache.flush(0);
    }
}
/// Wraps the IOSurface CEF lends for the duration of on_accelerated_paint, with the IOSurface's ID.
pub fn wrap_accelerated(info: &cef::AcceleratedPaintInfo) -> Option<(CVPixelBuffer, u32)> {
    if info.shared_texture_io_surface.is_null() {
        return None;
    }
    let mut raw = std::ptr::null_mut();
    // SAFETY: CEF lends a live IOSurfaceRef during this callback. CoreVideo returns
    // an owned CVPixelBuffer reference, balanced by its Rust wrapper before return.
    let status = unsafe {
        core_video::pixel_buffer_io_surface::CVPixelBufferCreateWithIOSurface(
            std::ptr::null(),
            info.shared_texture_io_surface.cast_const().cast(),
            std::ptr::null(),
            &mut raw,
        )
    };
    if status != 0 || raw.is_null() {
        return None;
    }
    // SAFETY: success above transfers one non-null owned CoreVideo reference.
    let source: CVPixelBuffer = unsafe { TCFType::wrap_under_create_rule(raw) };
    assert_eq!(source.get_pixel_format(), kCVPixelFormatType_32BGRA);
    // SAFETY: CEF lends a live IOSurfaceRef for the duration of this callback.
    let id = unsafe { IOSurfaceGetID(info.shared_texture_io_surface.cast_const().cast()) };
    Some((source, id))
}
pub fn copy_accelerated(
    pool: &mut crate::frame_pool::FramePool,
    gpu: &GpuCopy,
    info: &cef::AcceleratedPaintInfo,
) -> Option<CVPixelBuffer> {
    let (source, _) = wrap_accelerated(info)?;
    let frame = pool.acquire(source.get_width(), source.get_height());
    gpu.copy(&source, &frame);
    Some(frame)
}

// NSNotificationCenter wakes the pump when visibility changes, with no idle poll.
// Observers live until process exit; the notification center retains their blocks.
#[allow(unexpected_cfgs)]
pub fn observe_visibility(tx: async_channel::Sender<crate::pump::Message>) {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    // SAFETY: called on the AppKit main thread; notification names are immutable
    // NSStrings, blocks are copied/retained by the center, and no input is posted.
    unsafe {
        let center: *mut Object = msg_send![class!(NSNotificationCenter), defaultCenter];
        for name in [
            "NSWindowDidMiniaturizeNotification",
            "NSWindowDidDeminiaturizeNotification",
            "NSApplicationDidHideNotification",
            "NSApplicationDidUnhideNotification",
        ] {
            let string: *mut Object = msg_send![class!(NSString), alloc];
            let string: *mut Object =
                msg_send![string,initWithBytes:name.as_ptr() length:name.len() encoding:4usize];
            let tx = tx.clone();
            let callback = block::ConcreteBlock::new(move |_: *mut Object| {
                let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
                let hidden: bool = msg_send![app, isHidden];
                let windows: *mut Object = msg_send![app, windows];
                let window: *mut Object = msg_send![windows, firstObject];
                let mini: bool = if window.is_null() {
                    false
                } else {
                    msg_send![window, isMiniaturized]
                };
                let _ = tx.try_send(crate::pump::Message::Visible(!hidden && !mini));
            })
            .copy();
            let _: *mut Object = msg_send![center,addObserverForName:string object:std::ptr::null_mut::<Object>() queue:std::ptr::null_mut::<Object>() usingBlock:&*callback];
            let _: () = msg_send![string, release];
        }
    }
}
