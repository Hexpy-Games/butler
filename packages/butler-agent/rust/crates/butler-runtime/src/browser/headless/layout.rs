//! Optional content crop hints (the App executor's `layout.mjs`); they never
//! change an explicitly requested capture.
use super::{
    js::{jnum, num},
    state::Geometry,
};
use serde_json::{Value, json};

#[expect(
    clippy::many_single_char_names,
    reason = "geometry names mirror the App executor"
)]
pub(crate) fn content_regions(regions: &[Value], geometry: Option<Geometry>) -> Value {
    let Some(g) = geometry else {
        return json!([]);
    };
    let (mut left, mut top, mut right, mut bottom) = (0.0, 0.0, g.css_width, g.css_height);
    for region in regions {
        let kind = region["kind"].as_str().unwrap_or("");
        if region["frame"] != "f0"
            || region["contains_fields"] == true
            || !matches!(kind, "header" | "nav" | "banner" | "navigation")
        {
            continue;
        }
        let r = &region["rect"];
        let (x, y, w, h) = (
            num(&r["x"], 0.0),
            num(&r["y"], 0.0),
            num(&r["width"], 0.0),
            num(&r["height"], 0.0),
        );
        if h >= g.css_height * 0.7 && w <= g.css_width * 0.2 {
            if x <= 1.0 {
                left = f64::max(left, x + w);
            }
            if x + w >= g.css_width - 1.0 {
                right = f64::min(right, x);
            }
        }
        if w >= g.css_width * 0.7 && h <= g.css_height * 0.2 {
            if y <= 1.0 {
                top = f64::max(top, y + h);
            }
            if y + h >= g.css_height - 1.0 {
                bottom = f64::min(bottom, y);
            }
        }
    }
    let mut canvases = canvas_regions(regions, g);
    if left == 0.0 && top == 0.0 && right == g.css_width && bottom == g.css_height {
        return Value::Array(canvases);
    }
    let x = (left * g.width / g.css_width).ceil();
    let y = (top * g.height / g.css_height).ceil();
    let far_x = (right * g.width / g.css_width).floor();
    let far_y = (bottom * g.height / g.css_height).floor();
    if far_x <= x || far_y <= y {
        return Value::Array(canvases);
    }
    canvases.insert(0, json!({"name":"viewport_without_edge_navigation","region":[jnum(x), jnum(y), jnum(far_x - x), jnum(far_y - y)],
        "verification":"Candidate excludes semantic edge navigation only. Check the screenshot: retain all requested content before choosing it."}));
    Value::Array(canvases)
}

fn canvas_regions(regions: &[Value], g: Geometry) -> Vec<Value> {
    regions
        .iter()
        .filter(|region| region["kind"] == "canvas")
        .filter_map(|region| {
            let r = &region["rect"];
            let (rx, ry, rw, rh) = (num(&r["x"], 0.0), num(&r["y"], 0.0), num(&r["width"], 0.0), num(&r["height"], 0.0));
            let x = f64::max(0.0, (rx * g.width / g.css_width).ceil());
            let y = f64::max(0.0, (ry * g.height / g.css_height).ceil());
            let far_x = f64::min(g.width, ((rx + rw) * g.width / g.css_width).floor());
            let far_y = f64::min(g.height, ((ry + rh) * g.height / g.css_height).floor());
            (far_x - x > 0.0 && far_y - y > 0.0).then(|| {
                json!({"name":region["name"],"region":[jnum(x), jnum(y), jnum(far_x - x), jnum(far_y - y)],"bounds":{"left":jnum(x),"top":jnum(y),"right":jnum(far_x),"bottom":jnum(far_y)},
                    "verification":"Visible canvas bounds in screenshot coordinates. Check fresh pixels before choosing this crop."})
            })
        })
        .collect()
}
