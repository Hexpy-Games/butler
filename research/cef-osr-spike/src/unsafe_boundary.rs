#![allow(unsafe_code)]
// Foreign frame lifetimes and CoreVideo addresses cannot be expressed by these safe APIs.
use core_foundation::base::TCFType;
use core_video::pixel_buffer::{CVPixelBuffer, kCVPixelFormatType_32BGRA};

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
pub fn copy_accelerated(
    pool: &mut crate::frame_pool::FramePool,
    info: &cef::AcceleratedPaintInfo,
) -> Option<CVPixelBuffer> {
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
    if source.lock_base_address(1) != 0 {
        return None;
    }
    let copy = copy_paint(
        pool,
        // SAFETY: the source is locked read-only until copy_paint completes.
        unsafe { source.get_base_address().cast() },
        source.get_width(),
        source.get_height(),
        source.get_bytes_per_row(),
    );
    assert_eq!(source.unlock_base_address(1), 0);
    copy
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
