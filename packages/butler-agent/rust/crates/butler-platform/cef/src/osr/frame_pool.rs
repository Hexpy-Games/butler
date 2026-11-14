use super::OsrError;
use core_foundation::{
    base::{CFType, TCFType},
    boolean::CFBoolean,
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
use core_video::{
    pixel_buffer::{CVPixelBuffer, CVPixelBufferKeys, kCVPixelFormatType_32BGRA},
    pixel_buffer_pool::{CVPixelBufferPool, CVPixelBufferPoolKeys},
};

#[derive(Default)]
pub(super) struct FramePool {
    dimensions: (usize, usize),
    pool: Option<CVPixelBufferPool>,
}
impl FramePool {
    pub(super) fn acquire(
        &mut self,
        width: usize,
        height: usize,
    ) -> Result<CVPixelBuffer, OsrError> {
        if self.dimensions != (width, height) || self.pool.is_none() {
            let pixels = attributes(width, height)?;
            let attributes = CFDictionary::from_CFType_pairs(&[(
                CVPixelBufferPoolKeys::MaximumBufferAge.into(),
                CFNumber::from(0).as_CFType(),
            )]);
            let pool = CVPixelBufferPool::new(Some(&attributes), Some(&pixels))
                .map_err(|code| OsrError(format!("create frame pool: {code}")))?;
            self.pool = Some(pool);
            self.dimensions = (width, height);
        }
        let limit = CFDictionary::from_CFType_pairs(&[(
            CVPixelBufferPoolKeys::AllocationThreshold.into(),
            CFNumber::from(6).as_CFType(),
        )]);
        let pool = self
            .pool
            .as_ref()
            .ok_or_else(|| OsrError("missing frame pool".into()))?;
        pool.create_pixel_buffer_with_aux_attributes(Some(&limit))
            .map_err(|code| OsrError(format!("acquire bounded frame buffer: {code}")))
    }
}

fn attributes(width: usize, height: usize) -> Result<CFDictionary<CFString, CFType>, OsrError> {
    let width = i64::try_from(width).map_err(|e| OsrError(e.to_string()))?;
    let height = i64::try_from(height).map_err(|e| OsrError(e.to_string()))?;
    Ok(CFDictionary::from_CFType_pairs(&[
        (
            CVPixelBufferKeys::PixelFormatType.into(),
            CFNumber::from(i64::from(kCVPixelFormatType_32BGRA)).as_CFType(),
        ),
        (
            CVPixelBufferKeys::Width.into(),
            CFNumber::from(width).as_CFType(),
        ),
        (
            CVPixelBufferKeys::Height.into(),
            CFNumber::from(height).as_CFType(),
        ),
        (
            CVPixelBufferKeys::IOSurfaceProperties.into(),
            CFDictionary::<CFString, CFType>::from_CFType_pairs(&[]).as_CFType(),
        ),
        (
            CVPixelBufferKeys::MetalCompatibility.into(),
            CFBoolean::true_value().as_CFType(),
        ),
    ]))
}
