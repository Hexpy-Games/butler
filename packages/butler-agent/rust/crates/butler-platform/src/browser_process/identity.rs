//! Chrome identity using the running engine's native OS and CPU facts.
use serde_json::{Value, json};

/// Keeps Chromium's platform spelling and Chrome's version-seeded GREASE
/// format. `native` is Chromium's own high-entropy userAgentData, not an OS
/// version guessed from a kernel version (notably Windows and macOS).
pub fn chrome_identity(ua: &str, full: &str, native: &Value, language: &str) -> Option<Value> {
    let major = full.split('.').next()?.parse::<usize>().ok()?;
    let (prefix, suffix) = ua.split_once("(KHTML, like Gecko)")?;
    let safari = suffix
        .split_whitespace()
        .find(|part| part.starts_with("Safari/"))?;
    let user_agent = format!("{prefix}(KHTML, like Gecko) Chrome/{full} {safari}");
    Some(json!({"userAgent":user_agent,"acceptLanguage":language,
        "userAgentMetadata":{
            "brands":brands(major, &major.to_string(), false),
            "fullVersionList":brands(major, full, true),"fullVersion":full,
            "platform":native["platform"],"platformVersion":native["platformVersion"],
            "architecture":native["architecture"],"bitness":native["bitness"],
            "model":native["model"],"wow64":native["wow64"],"mobile":false,
            "formFactors":["Desktop"]}}))
}

fn brands(major: usize, version: &str, full: bool) -> Vec<Value> {
    let chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
    let grease = format!(
        "Not{}A{}Brand",
        chars.get(major % chars.len()).copied().unwrap_or(""),
        chars.get((major + 1) % chars.len()).copied().unwrap_or("")
    );
    let grease_version = ["8", "99", "24"].get(major % 3).copied().unwrap_or("8");
    let grease_version = if full {
        format!("{grease_version}.0.0.0")
    } else {
        grease_version.to_owned()
    };
    let list = [
        json!({"brand":grease,"version":grease_version}),
        json!({"brand":"Chromium","version":version}),
        json!({"brand":"Google Chrome","version":version}),
    ];
    let orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    let order = orders
        .get(major % orders.len())
        .copied()
        .unwrap_or([0, 1, 2]);
    let mut shuffled = vec![Value::Null; 3];
    for (item, position) in list.into_iter().zip(order) {
        if let Some(slot) = shuffled.get_mut(position) {
            *slot = item;
        }
    }
    shuffled
}
