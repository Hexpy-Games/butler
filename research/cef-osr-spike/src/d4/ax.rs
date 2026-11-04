#![allow(unsafe_code, unexpected_cfgs)]
// In-process NSAccessibility queries run on AppKit's main thread; no AX client/TCC access.
use super::inject::{self, Rect};
use cef::*;
use core_foundation::base::{CFRelease, CFTypeRef};
use objc::{msg_send, runtime::Object, sel, sel_impl};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::VecDeque};
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> CFTypeRef;
}
unsafe fn attribute(node: *mut Object, selector: objc::runtime::Sel) -> *mut Object {
    unsafe {
        let responds: bool = msg_send![node, respondsToSelector:selector];
        if responds {
            let value: *mut Object = msg_send![node, performSelector:selector];
            value
        } else {
            std::ptr::null_mut()
        }
    }
}
fn describe(node: *mut Object) -> Value {
    if node.is_null() {
        return Value::Null;
    }
    unsafe {
        let mut result = json!({});
        for (key, selector) in [
            ("role", sel!(accessibilityRole)),
            ("subrole", sel!(accessibilitySubrole)),
            ("roleDescription", sel!(accessibilityRoleDescription)),
            ("label", sel!(accessibilityLabel)),
            ("title", sel!(accessibilityTitle)),
            ("value", sel!(accessibilityValue)),
            ("identifier", sel!(accessibilityIdentifier)),
        ] {
            let value = inject::string(attribute(node, selector));
            result[key] = json!(if key == "value" {
                value.chars().take(200).collect::<String>()
            } else {
                value
            });
        }
        for (key, selector) in [
            ("enabled", sel!(isAccessibilityEnabled)),
            ("focused", sel!(isAccessibilityFocused)),
        ] {
            let responds: bool = msg_send![node, respondsToSelector:selector];
            result[key] = if responds {
                let value: bool = if key == "enabled" {
                    msg_send![node, isAccessibilityEnabled]
                } else {
                    msg_send![node, isAccessibilityFocused]
                };
                json!(value)
            } else {
                Value::Null
            };
        }
        let responds: bool = msg_send![node, respondsToSelector:sel!(accessibilityFrame)];
        if responds {
            let frame: Rect = msg_send![node, accessibilityFrame];
            result["frame"] = inject::top_left(frame);
        }
        result
    }
}
fn walk(node: *mut Object, depth: usize, remaining: &mut usize) -> Value {
    if node.is_null() || depth > 30 || *remaining == 0 {
        return Value::Null;
    }
    *remaining -= 1;
    let mut result = describe(node);
    unsafe {
        let children = attribute(node, sel!(accessibilityChildren));
        let count: usize = if children.is_null() {
            0
        } else {
            msg_send![children, count]
        };
        result["child_count"] = json!(count);
        let mut nodes = Vec::new();
        for i in 0..count {
            if depth == 30 || *remaining == 0 {
                break;
            }
            let child: *mut Object = msg_send![children, objectAtIndex:i];
            nodes.push(walk(child, depth + 1, remaining));
        }
        result["children"] = json!(nodes);
    }
    result
}
pub fn focused() -> Value {
    unsafe {
        describe(attribute(
            inject::app(),
            sel!(accessibilityFocusedUIElement),
        ))
    }
}
pub fn dump_ax(window: *mut Object) -> Value {
    json!({"window":walk(window,0,&mut 2000),"focused":focused()})
}
unsafe fn item(dict: *mut Object, key: &str) -> *mut Object {
    unsafe { msg_send![dict, objectForKey:inject::ns(key)] }
}
unsafe fn number(dict: *mut Object, key: &str) -> f64 {
    unsafe {
        let value = item(dict, key);
        if value.is_null() {
            0.
        } else {
            msg_send![value, doubleValue]
        }
    }
}
pub fn foreign_windows() -> Value {
    unsafe {
        let list = CGWindowListCopyWindowInfo(1, 0);
        if list.is_null() {
            return json!([]);
        }
        let window = inject::window("main");
        let frame = inject::top_left(inject::frame(window));
        let x = frame["x"].as_f64().unwrap_or(0.) - 400.;
        let y = frame["y"].as_f64().unwrap_or(0.) - 400.;
        let right = x + frame["width"].as_f64().unwrap_or(0.) + 800.;
        let bottom = y + frame["height"].as_f64().unwrap_or(0.) + 800.;
        let count: usize = msg_send![list as *mut Object, count];
        let mut result = Vec::new();
        for i in 0..count {
            let d: *mut Object = msg_send![list as *mut Object, objectAtIndex:i];
            if number(d, "kCGWindowOwnerPID") as u32 == std::process::id() {
                continue;
            }
            let b = item(d, "kCGWindowBounds");
            let (bx, by, bw, bh) = (
                number(b, "X"),
                number(b, "Y"),
                number(b, "Width"),
                number(b, "Height"),
            );
            if bx < right && by < bottom && bx + bw > x && by + bh > y {
                result.push(json!({"owner":inject::string(item(d,"kCGWindowOwnerName")),"layer":number(d,"kCGWindowLayer"),"bounds":{"x":bx,"y":by,"width":bw,"height":bh}}));
            }
        }
        CFRelease(list);
        json!(result)
    }
}
#[derive(Default)]
struct CefStats {
    tree: usize,
    location: usize,
    payloads: VecDeque<String>,
}
thread_local! { static CEF: RefCell<CefStats> = RefCell::default(); }
cef::wrap_accessibility_handler! {
    pub struct CefAccessibility {}
    impl AccessibilityHandler {
        fn on_accessibility_tree_change(&self, value: Option<&mut cef::Value>) {
            let payload = cef::CefString::from(&cef::write_json(value, cef::JsonWriterOptions::default())).to_string();
            CEF.with_borrow_mut(|s| {
                s.tree += 1;
                let mut end = payload.len().min(65536);
                while !payload.is_char_boundary(end) { end -= 1; }
                s.payloads.push_back(payload[..end].to_owned());
                while s.payloads.len() > 20 || s.payloads.iter().map(String::len).sum::<usize>() > 65536 { s.payloads.pop_front(); }
            });
        }
        fn on_accessibility_location_change(&self, _value: Option<&mut cef::Value>) {
            CEF.with_borrow_mut(|s| s.location += 1);
        }
    }
}
pub fn cef_snapshot() -> Value {
    CEF.with_borrow(|s| {
        let payload = s.payloads.iter().cloned().collect::<String>();
        json!({"tree_changes":s.tree,"location_changes":s.location,"payloads":s.payloads,
            "contains_web_heading":payload.contains("웹 제목"),"contains_web_button":payload.contains("웹 버튼")})
    })
}
pub fn nodes<'a>(value: &'a Value, result: &mut Vec<&'a Value>) {
    if !value["role"].is_null() {
        result.push(value);
    }
    if let Some(children) = value["children"].as_array() {
        for child in children {
            nodes(child, result);
        }
    }
    if !value["window"].is_null() {
        nodes(&value["window"], result);
    }
}
