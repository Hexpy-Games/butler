//! Frame-local CSS geometry placed in the main viewport, clipped through every frame owner.
use serde_json::{Value, json};

pub(super) fn n(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or(0.)
}
pub(super) fn rect(x: f64, y: f64, width: f64, height: f64) -> Value {
    json!({ "x": x, "y": y, "width": width, "height": height })
}
pub(super) fn meet(a: &Value, b: &Value) -> Option<Value> {
    let x = n(a, "x").max(n(b, "x"));
    let y = n(a, "y").max(n(b, "y"));
    let right = (n(a, "x") + n(a, "width")).min(n(b, "x") + n(b, "width"));
    let bottom = (n(a, "y") + n(a, "height")).min(n(b, "y") + n(b, "height"));
    (right - x >= 0.5 && bottom - y >= 0.5).then(|| rect(x, y, right - x, bottom - y))
}
pub(super) fn shift(v: &Value, x: f64, y: f64) -> Value {
    rect(n(v, "x") + x, n(v, "y") + y, n(v, "width"), n(v, "height"))
}
pub(super) fn edges(v: &Value) -> Value {
    rect(
        n(v, "left"),
        n(v, "top"),
        n(v, "right") - n(v, "left"),
        n(v, "bottom") - n(v, "top"),
    )
}
pub(super) fn same(a: &Value, b: &Value, tolerance: f64) -> bool {
    let edges = |v: &Value| {
        [
            n(v, "x"),
            n(v, "y"),
            n(v, "x") + n(v, "width"),
            n(v, "y") + n(v, "height"),
        ]
    };
    edges(a)
        .into_iter()
        .zip(edges(b))
        .all(|(a, b)| (a - b).abs() <= tolerance)
}
#[cfg(feature = "cef")]
pub(super) fn contains(v: &Value, x: f64, y: f64) -> bool {
    x >= n(v, "x")
        && x < n(v, "x") + n(v, "width")
        && y >= n(v, "y")
        && y < n(v, "y") + n(v, "height")
}
