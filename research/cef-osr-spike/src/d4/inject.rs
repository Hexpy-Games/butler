#![allow(unsafe_code, unexpected_cfgs)]
// AppKit/Carbon calls are confined to the main thread, with owned TIS references balanced below.
use core_foundation::{
    base::TCFType,
    base::{CFRelease, CFTypeRef},
    string::{CFString, CFStringRef},
};
use objc::{class, msg_send, runtime::Object, sel, sel_impl};
use std::ffi::{CStr, c_void};
#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct Rect {
    pub origin: Point,
    pub size: Size,
}
unsafe impl objc::Encode for Point {
    fn encode() -> objc::Encoding {
        unsafe { objc::Encoding::from_str("{CGPoint=dd}") }
    }
}
unsafe impl objc::Encode for Rect {
    fn encode() -> objc::Encoding {
        unsafe { objc::Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
    }
}
#[derive(Clone, Copy, Default)]
#[repr(C)]
struct NativeRange {
    location: usize,
    length: usize,
}
unsafe impl objc::Encode for NativeRange {
    fn encode() -> objc::Encoding {
        unsafe { objc::Encoding::from_str("{_NSRange=QQ}") }
    }
}
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyInputSourceID: CFStringRef;
    fn TISCopyCurrentKeyboardInputSource() -> CFTypeRef;
    fn TISCreateInputSourceList(properties: CFTypeRef, include_all: bool) -> CFTypeRef;
    fn TISSelectInputSource(source: CFTypeRef) -> i32;
}
pub struct InputSource(CFTypeRef);
impl InputSource {
    pub fn remember() -> Self {
        Self(unsafe { TISCopyCurrentKeyboardInputSource() })
    }
    pub fn restore(&self) -> bool {
        !self.0.is_null() && unsafe { TISSelectInputSource(self.0) == 0 }
    }
}
impl Drop for InputSource {
    fn drop(&mut self) {
        self.restore();
        if !self.0.is_null() {
            unsafe {
                CFRelease(self.0);
            }
        }
    }
}
pub fn select_input_source(id: &str) -> Result<(), String> {
    unsafe {
        let id = CFString::new(id);
        let key = kTISPropertyInputSourceID as *mut Object;
        let dict: *mut Object = msg_send![class!(NSDictionary), dictionaryWithObject:id.as_concrete_TypeRef() as *mut Object forKey:key];
        let sources = TISCreateInputSourceList(dict.cast(), false);
        if sources.is_null() {
            return Err("TISCreateInputSourceList returned null".into());
        }
        let count: usize = msg_send![sources as *mut Object, count];
        let status = if count > 0 {
            let source: *mut Object = msg_send![sources as *mut Object, objectAtIndex:0usize];
            TISSelectInputSource(source.cast())
        } else {
            -1
        };
        CFRelease(sources);
        if status == 0 {
            Ok(())
        } else {
            Err(format!("cannot select input source: {status}"))
        }
    }
}
pub fn app() -> *mut Object {
    unsafe { msg_send![class!(NSApplication), sharedApplication] }
}
pub fn key_window() -> *mut Object {
    unsafe { msg_send![app(), keyWindow] }
}
pub fn window(title: &str) -> *mut Object {
    unsafe {
        let windows: *mut Object = msg_send![app(), windows];
        let count: usize = msg_send![windows, count];
        for i in 0..count {
            let w: *mut Object = msg_send![windows, objectAtIndex:i];
            let t: *mut Object = msg_send![w, title];
            if string(t) == title {
                return w;
            }
        }
        std::ptr::null_mut()
    }
}
pub fn make_key(title: &str) {
    unsafe {
        let _: () = msg_send![window(title), makeKeyAndOrderFront:std::ptr::null_mut::<Object>()];
    }
}
pub fn string(object: *mut Object) -> String {
    if object.is_null() {
        return String::new();
    }
    unsafe {
        let description: *mut Object = msg_send![object, description];
        let bytes: *const i8 = msg_send![description, UTF8String];
        if bytes.is_null() {
            String::new()
        } else {
            CStr::from_ptr(bytes).to_string_lossy().into_owned()
        }
    }
}
pub fn ns(text: &str) -> *mut Object {
    unsafe {
        msg_send![class!(NSString), stringWithBytes:text.as_ptr() length:text.len() encoding:4usize]
    }
}
pub fn key(keycode: u16, chars: &str, ignoring: &str, modifiers: u64) {
    unsafe {
        let number: isize = msg_send![key_window(), windowNumber];
        for kind in [10usize, 11] {
            let event: *mut Object = msg_send![class!(NSEvent), keyEventWithType:kind
                location:Point::default() modifierFlags:modifiers timestamp:0f64 windowNumber:number
                context:std::ptr::null_mut::<c_void>() characters:ns(chars)
                charactersIgnoringModifiers:ns(ignoring) isARepeat:false keyCode:keycode];
            let _: () = msg_send![app(), postEvent:event atStart:false];
        }
    }
}
pub fn click(window: *mut Object, point: Point) {
    unsafe {
        let number: isize = msg_send![window, windowNumber];
        for kind in [1usize, 2] {
            let event: *mut Object = msg_send![class!(NSEvent), mouseEventWithType:kind location:point
                modifierFlags:0u64 timestamp:0f64 windowNumber:number context:std::ptr::null_mut::<c_void>()
                eventNumber:0isize clickCount:1isize pressure:1f32];
            let _: () = msg_send![app(), postEvent:event atStart:false];
        }
    }
}
pub fn ascii(c: char) {
    let lower = c.to_ascii_lowercase();
    let codes = [
        ("asdfhgzxcv", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].as_slice()),
        ("bqwerty", [11, 12, 13, 14, 15, 16, 17].as_slice()),
        (
            "123465=97-80",
            [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29].as_slice(),
        ),
        ("ouip", [31, 32, 34, 35].as_slice()),
        ("ljk", [37, 38, 40].as_slice()),
        ("nm", [45, 46].as_slice()),
        (" .,/", [49, 47, 43, 44].as_slice()),
    ];
    let base = if c == '?' { '/' } else { lower };
    let code = codes
        .iter()
        .find_map(|(chars, codes)| chars.chars().position(|v| v == base).map(|i| codes[i]))
        .expect("ANSI ASCII key");
    key(
        code,
        &c.to_string(),
        &base.to_string(),
        if c.is_ascii_uppercase() || c == '?' {
            1 << 17
        } else {
            0
        },
    );
}
pub fn frame(w: *mut Object) -> Rect {
    unsafe { msg_send![w, frame] }
}
pub fn screen_height() -> f64 {
    unsafe {
        let screen: *mut Object = msg_send![class!(NSScreen), mainScreen];
        let r: Rect = msg_send![screen, frame];
        r.size.height
    }
}
pub fn top_left(r: Rect) -> serde_json::Value {
    serde_json::json!({"x":r.origin.x,"y":screen_height()-r.origin.y-r.size.height,"width":r.size.width,"height":r.size.height})
}
pub fn status() -> serde_json::Value {
    unsafe {
        let active: bool = msg_send![app(), isActive];
        let title: *mut Object = msg_send![key_window(), title];
        serde_json::json!({"isActive":active,"key_window":string(title)})
    }
}
pub fn shot_info() -> serde_json::Value {
    unsafe {
        let scale: f64 = msg_send![window("main"), backingScaleFactor];
        serde_json::json!({"window_frame":top_left(frame(window("main"))),"backing_scale":scale,"foreign_windows":super::ax::foreign_windows()})
    }
}
pub fn caret_rect() -> serde_json::Value {
    unsafe {
        let view: *mut Object = msg_send![key_window(), firstResponder];
        if view.is_null() {
            return serde_json::Value::Null;
        }
        let responds: bool =
            msg_send![view, respondsToSelector:sel!(firstRectForCharacterRange:actualRange:)];
        if !responds {
            return serde_json::Value::Null;
        }
        let mut range = NativeRange::default();
        let marked: NativeRange = msg_send![view, markedRange];
        let selected: NativeRange = msg_send![view, selectedRange];
        let requested = if marked.location != isize::MAX as usize {
            marked
        } else {
            NativeRange {
                location: selected.location.saturating_add(selected.length),
                length: 0,
            }
        };
        let rect: Rect = msg_send![view, firstRectForCharacterRange:requested actualRange:&mut range as *mut NativeRange];
        top_left(rect)
    }
}

pub fn click_content(w: *mut Object, mut point: Point) {
    unsafe {
        let view: *mut Object = msg_send![w, contentView];
        let flipped: bool = msg_send![view, isFlipped];
        if !flipped {
            let bounds: Rect = msg_send![view, bounds];
            point.y = bounds.size.height - point.y;
        }
        let point: Point =
            msg_send![view, convertPoint:point toView:std::ptr::null_mut::<Object>()];
        click(w, point);
    }
}
pub async fn type_keys(text: &str, cx: &gpui::AsyncApp) {
    for c in text.chars() {
        ascii(c);
        cx.background_executor()
            .timer(std::time::Duration::from_millis(35))
            .await;
    }
}
