use core_foundation::{
    base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, number::CFNumber,
};
use core_video::{
    pixel_buffer::{CVPixelBuffer, CVPixelBufferKeys, kCVPixelFormatType_32BGRA},
    pixel_buffer_pool::{CVPixelBufferPool, CVPixelBufferPoolKeys},
};
use std::collections::HashSet;

// Allocated on demand. The cap includes frames held by GPUI scenes and Metal.
const MAX_BUFFERS: i32 = 6;
#[derive(Default)]
pub struct FramePool {
    dimensions: (usize, usize),
    pool: Option<CVPixelBufferPool>,
    buffers: HashSet<usize>,
    requests: u64,
}
impl FramePool {
    pub fn acquire(&mut self, width: usize, height: usize) -> CVPixelBuffer {
        if self.dimensions != (width, height) {
            *self = Self::default();
            self.dimensions = (width, height);
            let attributes = CFDictionary::from_CFType_pairs(&[(
                CVPixelBufferPoolKeys::MaximumBufferAge.into(),
                CFNumber::from(0).as_CFType(),
            )]);
            let pixels =
                CFDictionary::from_CFType_pairs(&[
                    (
                        CVPixelBufferKeys::PixelFormatType.into(),
                        CFNumber::from(kCVPixelFormatType_32BGRA as i64).as_CFType(),
                    ),
                    (
                        CVPixelBufferKeys::Width.into(),
                        CFNumber::from(width as i64).as_CFType(),
                    ),
                    (
                        CVPixelBufferKeys::Height.into(),
                        CFNumber::from(height as i64).as_CFType(),
                    ),
                    (
                        CVPixelBufferKeys::IOSurfaceProperties.into(),
                        CFDictionary::<
                            core_foundation::string::CFString,
                            core_foundation::base::CFType,
                        >::from_CFType_pairs(&[])
                        .as_CFType(),
                    ),
                    (
                        CVPixelBufferKeys::MetalCompatibility.into(),
                        CFBoolean::true_value().as_CFType(),
                    ),
                ]);
            self.pool = Some(
                CVPixelBufferPool::new(Some(&attributes), Some(&pixels))
                    .expect("Create frame pool"),
            );
            crate::log(
                "frame_pool_created",
                serde_json::json!({"width":width,"height":height,"capacity":MAX_BUFFERS}),
            );
        }
        let limit = CFDictionary::from_CFType_pairs(&[(
            CVPixelBufferPoolKeys::AllocationThreshold.into(),
            CFNumber::from(MAX_BUFFERS).as_CFType(),
        )]);
        // CoreVideo returns only buffers no longer owned by a scene or GPU job.
        // Exhaustion is a failed experiment, never a silent frame drop or overwrite.
        let frame = self
            .pool
            .as_ref()
            .unwrap()
            .create_pixel_buffer_with_aux_attributes(Some(&limit))
            .expect("Bounded frame pool exhausted; refusing to drop or overwrite a frame");
        self.requests += 1;
        self.buffers.insert(frame.as_concrete_TypeRef() as usize);
        frame
    }
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({"dimensions":self.dimensions,"capacity":MAX_BUFFERS,"requests":self.requests,"unique_buffers":self.buffers.len()})
    }
}
