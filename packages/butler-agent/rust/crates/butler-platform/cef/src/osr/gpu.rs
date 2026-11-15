//! Audited IOSurface, CoreVideo and Metal lifetime boundary.
#![allow(unsafe_code)]
use super::OsrError;
use core_foundation::base::TCFType;
use core_video::{
    metal_texture::{CVMetalTexture, CVMetalTextureGetTexture},
    metal_texture_cache::CVMetalTextureCache,
    pixel_buffer::{CVPixelBuffer, kCVPixelFormatType_32BGRA},
};
use foreign_types::ForeignTypeRef;
use std::{ffi::CString, os::unix::ffi::OsStrExt, path::Path};

pub(super) struct Framework;
impl Framework {
    pub(super) fn load(directory: &Path) -> Result<Self, OsrError> {
        let binary = directory.join("Chromium Embedded Framework");
        let name =
            CString::new(binary.as_os_str().as_bytes()).map_err(|e| OsrError(e.to_string()))?;
        // SAFETY: CString owns a NUL-terminated path and outlives the synchronous load.
        if cef::load_library(Some(unsafe { &*name.as_ptr() })) != 1 {
            return Err(OsrError("load CEF framework failed".into()));
        }
        Ok(Self)
    }
}
impl Drop for Framework {
    fn drop(&mut self) {
        let _ = cef::unload_library();
    }
}

pub(super) struct GpuCopy {
    queue: metal::CommandQueue,
    cache: CVMetalTextureCache,
}
impl GpuCopy {
    pub(super) fn new() -> Result<Self, OsrError> {
        let device =
            metal::Device::system_default().ok_or_else(|| OsrError("Metal unavailable".into()))?;
        let queue = device.new_command_queue();
        let cache = CVMetalTextureCache::new(None, device, None)
            .map_err(|code| OsrError(format!("create Metal texture cache: {code}")))?;
        Ok(Self { queue, cache })
    }
    fn texture(&self, buffer: &CVPixelBuffer) -> Result<CVMetalTexture, OsrError> {
        self.cache
            .create_texture_from_image(
                buffer.as_concrete_TypeRef(),
                None,
                metal::MTLPixelFormat::BGRA8Unorm,
                buffer.get_width(),
                buffer.get_height(),
                0,
            )
            .map_err(|code| OsrError(format!("create frame texture: {code}")))
    }
    pub(super) fn copy(
        &self,
        source: &CVPixelBuffer,
        target: &CVPixelBuffer,
    ) -> Result<(), OsrError> {
        let result = objc::rc::autoreleasepool(|| {
            let (from, to) = (self.texture(source)?, self.texture(target)?);
            // SAFETY: Both CVMetalTextures own their textures through completion of this blit.
            let (from_ptr, to_ptr) = unsafe {
                (
                    CVMetalTextureGetTexture(from.as_concrete_TypeRef()),
                    CVMetalTextureGetTexture(to.as_concrete_TypeRef()),
                )
            };
            if from_ptr.is_null() || to_ptr.is_null() {
                return Err(OsrError("missing Metal texture".into()));
            }
            // SAFETY: Non-null borrowed textures are retained by `from` and `to` above.
            let (from_texture, to_texture) = unsafe {
                (
                    metal::TextureRef::from_ptr(from_ptr.cast()),
                    metal::TextureRef::from_ptr(to_ptr.cast()),
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
            // CEF reclaims the source IOSurface when its paint callback returns.
            command.wait_until_completed();
            if command.status() == metal::MTLCommandBufferStatus::Error {
                return Err(OsrError("Metal frame copy failed".into()));
            }
            Ok(())
        });
        self.cache.flush(0);
        result
    }
}

pub(super) fn wrap_accelerated(
    info: &cef::AcceleratedPaintInfo,
) -> Result<CVPixelBuffer, OsrError> {
    if info.shared_texture_io_surface.is_null() {
        return Err(OsrError("missing accelerated IOSurface".into()));
    }
    let mut raw = std::ptr::null_mut();
    // SAFETY: CEF lends a live IOSurface for this callback. The create rule returns ownership.
    let status = unsafe {
        core_video::pixel_buffer_io_surface::CVPixelBufferCreateWithIOSurface(
            std::ptr::null(),
            info.shared_texture_io_surface.cast_const().cast(),
            std::ptr::null(),
            &raw mut raw,
        )
    };
    if status != 0 || raw.is_null() {
        return Err(OsrError(format!("wrap accelerated IOSurface: {status}")));
    }
    // SAFETY: Successful creation above transferred one non-null CoreVideo reference.
    let source: CVPixelBuffer = unsafe { TCFType::wrap_under_create_rule(raw) };
    if source.get_pixel_format() != kCVPixelFormatType_32BGRA {
        return Err(OsrError("accelerated surface is not BGRA".into()));
    }
    Ok(source)
}

/// Read one BGRA pixel while holding a read-only CoreVideo base-address lock.
pub fn read_bgra_pixel(frame: &CVPixelBuffer, x: usize, y: usize) -> Result<[u8; 4], OsrError> {
    if frame.get_pixel_format() != kCVPixelFormatType_32BGRA
        || x >= frame.get_width()
        || y >= frame.get_height()
    {
        return Err(OsrError("invalid BGRA pixel coordinates or format".into()));
    }
    if frame.lock_base_address(1) != 0 {
        return Err(OsrError("lock frame for reading failed".into()));
    }
    let result = read_locked_pixel(frame, x, y);
    if frame.unlock_base_address(1) != 0 {
        return Err(OsrError("unlock frame failed".into()));
    }
    result
}
fn read_locked_pixel(frame: &CVPixelBuffer, x: usize, y: usize) -> Result<[u8; 4], OsrError> {
    let offset = y
        .checked_mul(frame.get_bytes_per_row())
        .and_then(|row| x.checked_mul(4).and_then(|column| row.checked_add(column)))
        .filter(|offset| {
            offset
                .checked_add(4)
                .is_some_and(|end| end <= frame.get_data_size())
        })
        .ok_or_else(|| OsrError("pixel exceeds frame storage".into()))?;
    // SAFETY: The caller holds the CoreVideo base-address lock until this read returns.
    let base = unsafe { frame.get_base_address() }.cast::<u8>();
    if base.is_null() {
        return Err(OsrError("missing frame storage".into()));
    }
    // SAFETY: The caller holds the base-address lock; the four bytes are within storage above.
    Ok(unsafe { std::ptr::read_unaligned(base.add(offset).cast::<[u8; 4]>()) })
}
