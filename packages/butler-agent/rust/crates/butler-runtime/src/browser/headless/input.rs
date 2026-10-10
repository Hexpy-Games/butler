//! Trusted input for headless tabs (`Input.*`), the CDP form of the App
//! executor's `sendInputEvent`/`insertText` calls in `act.mjs`,
//! `keyboard.mjs`, `drag.mjs` and `navigate.mjs`.
use super::{
    js::{num, round},
    page::Page,
    state::Upload,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::oneshot;

/// A parsed key chord: Electron key code, modifiers and the typed character.
#[derive(Clone, Debug)]
pub(crate) struct Chord {
    pub key_code: String,
    pub modifiers: Vec<&'static str>,
    pub character: Option<String>,
}

fn named(key: &str) -> Option<String> {
    let lower = key.to_lowercase();
    let name = match lower.as_str() {
        "enter" | "return" => "Enter",
        "tab" => "Tab",
        "escape" | "esc" => "Escape",
        "backspace" => "Backspace",
        "delete" | "del" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "space" | "spacebar" => "Space",
        "arrowup" | "up" => "Up",
        "arrowdown" | "down" => "Down",
        "arrowleft" | "left" => "Left",
        "arrowright" | "right" => "Right",
        "plus" => "Plus",
        _ => {
            let number = lower.strip_prefix('f')?.parse::<u8>().ok()?;
            return (1..=24).contains(&number).then(|| format!("F{number}"));
        }
    };
    Some(name.to_owned())
}

fn modifier(part: &str) -> Option<&'static str> {
    Some(match part.trim().to_lowercase().as_str() {
        "shift" => "shift",
        "control" | "ctrl" => "control",
        "alt" | "option" => "alt",
        "meta" | "cmd" | "command" => "meta",
        _ => return None,
    })
}

/// `"Enter"`, `"Control+Z"`, `"Shift+Tab"`, `"a"`: one chord per step.
pub(crate) fn parse_chord(value: &Value) -> Option<Chord> {
    let value = value.as_str()?;
    let trimmed = value.trim();
    if trimmed.is_empty() || value.encode_utf16().count() > 40 {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if trimmed == "+" {
        parts.push("+".into());
    } else {
        let chars: Vec<char> = trimmed.chars().collect();
        let mut current = String::new();
        for (index, ch) in chars.iter().enumerate() {
            if *ch == '+' && index + 1 < chars.len() {
                parts.push(std::mem::take(&mut current));
            } else {
                current.push(*ch);
            }
        }
        parts.push(current);
    }
    let key = parts.pop()?;
    let mut modifiers: Vec<&'static str> = Vec::new();
    for part in &parts {
        let m = modifier(part)?;
        if modifiers.contains(&m) {
            return None;
        }
        modifiers.push(m);
    }
    let typed = !modifiers.iter().any(|m| *m != "shift");
    if let Some(name) = named(key.trim()) {
        let character = typed.then(|| match name.as_str() {
            "Enter" | "Tab" | "Space" => Some(name.clone()),
            "Plus" => Some("+".to_owned()),
            _ => None,
        });
        return Some(Chord {
            key_code: name,
            modifiers,
            character: character.flatten(),
        });
    }
    if key.chars().count() != 1 {
        return None;
    }
    let upper = key.chars().all(char::is_uppercase);
    let key_code = if !modifiers.is_empty() && upper {
        key.to_lowercase()
    } else {
        key.clone()
    };
    let character = typed.then(|| {
        if modifiers.contains(&"shift") {
            key_code.to_uppercase()
        } else {
            key.clone()
        }
    });
    Some(Chord {
        key_code,
        modifiers,
        character,
    })
}

fn modifier_mask(names: &[&str]) -> u32 {
    names
        .iter()
        .map(|m| match *m {
            "alt" => 1,
            "control" => 2,
            "meta" => 4,
            "shift" => 8,
            _ => 0,
        })
        .sum()
}

/// CDP key identity for an Electron key code: (key, code, virtual key, text).
fn key_identity(chord: &Chord) -> (String, String, u32, Option<String>) {
    let text = chord.character.as_ref().map(|c| match c.as_str() {
        "Enter" => "\r".to_owned(),
        "Tab" => "\t".to_owned(),
        "Space" => " ".to_owned(),
        other => other.to_owned(),
    });
    let fixed =
        |key: &str, code: &str, vk: u32| (key.to_owned(), code.to_owned(), vk, text.clone());
    match chord.key_code.as_str() {
        "Enter" => fixed("Enter", "Enter", 13),
        "Tab" => fixed("Tab", "Tab", 9),
        "Escape" => fixed("Escape", "Escape", 27),
        "Backspace" => fixed("Backspace", "Backspace", 8),
        "Delete" => fixed("Delete", "Delete", 46),
        "Insert" => fixed("Insert", "Insert", 45),
        "Home" => fixed("Home", "Home", 36),
        "End" => fixed("End", "End", 35),
        "PageUp" => fixed("PageUp", "PageUp", 33),
        "PageDown" => fixed("PageDown", "PageDown", 34),
        "Space" => fixed(" ", "Space", 32),
        "Up" => fixed("ArrowUp", "ArrowUp", 38),
        "Down" => fixed("ArrowDown", "ArrowDown", 40),
        "Left" => fixed("ArrowLeft", "ArrowLeft", 37),
        "Right" => fixed("ArrowRight", "ArrowRight", 39),
        "Plus" => fixed("+", "Equal", 187),
        name if name.len() > 1 && name.starts_with('F') => {
            let number: u32 = name[1..].parse().unwrap_or(1);
            fixed(name, name, 111 + number)
        }
        single => {
            let ch = single.chars().next().unwrap_or(' ');
            let upper = ch.to_ascii_uppercase();
            let (code, vk) = if ch.is_ascii_alphabetic() {
                (format!("Key{upper}"), u32::from(upper))
            } else if ch.is_ascii_digit() {
                (format!("Digit{ch}"), u32::from(ch))
            } else {
                (String::new(), 0)
            };
            let key = text.clone().unwrap_or_else(|| single.to_owned());
            (key, code, vk, text.clone())
        }
    }
}

/// `keyDown` + `char` + `keyUp`, as the App sends them.
pub(crate) async fn press(page: &Page, chord: &Chord) -> Result<(), String> {
    let (key, code, vk, text) = key_identity(chord);
    let modifiers = modifier_mask(&chord.modifiers);
    let base = json!({"key":key,"code":code,"windowsVirtualKeyCode":vk,"nativeVirtualKeyCode":vk,"modifiers":modifiers});
    let with = |kind: &str, extra: Value| {
        let mut params = base.clone();
        params["type"] = json!(kind);
        if let (Some(target), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            target.extend(extra.clone());
        }
        params
    };
    page.input("Input.dispatchKeyEvent", with("rawKeyDown", json!({})))
        .await?;
    if let Some(text) = text {
        page.input(
            "Input.dispatchKeyEvent",
            with("char", json!({"text":text,"unmodifiedText":text})),
        )
        .await?;
    }
    page.input("Input.dispatchKeyEvent", with("keyUp", json!({})))
        .await
}

pub(crate) async fn insert_text(page: &Page, text: &str) -> Result<(), String> {
    page.input("Input.insertText", json!({"text":text})).await
}

fn button_mask(button: &str) -> u32 {
    match button {
        "right" => 2,
        "middle" => 4,
        _ => 1,
    }
}

pub(crate) fn step_modifiers(step: &Value) -> Vec<&'static str> {
    step["modifiers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| modifier(m.as_str().unwrap_or("")))
        .collect()
}

pub(crate) async fn move_to(page: &Page, x: f64, y: f64) -> Result<(), String> {
    page.mouse("mouseMoved", x, y, json!({"button":"none","buttons":0}))
        .await
}

pub(crate) async fn click(page: &Page, x: f64, y: f64, step: &Value) -> Result<(), String> {
    let button = step["button"].as_str().unwrap_or("left");
    let modifiers = modifier_mask(&step_modifiers(step));
    let count = step["click_count"].as_u64().unwrap_or(1);
    for n in 1..=count {
        page.mouse("mousePressed", x, y, json!({"button":button,"buttons":button_mask(button),"clickCount":n,"modifiers":modifiers})).await?;
        page.mouse(
            "mouseReleased",
            x,
            y,
            json!({"button":button,"buttons":0,"clickCount":n,"modifiers":modifiers}),
        )
        .await?;
    }
    Ok(())
}

/// Scroll values are `"dy"` or `"dx,dy"` page pixels.
pub(crate) async fn wheel(page: &Page, x: f64, y: f64, step: &Value) -> Result<(), String> {
    let raw = super::js::js_string(&step["value"]);
    let parts: Vec<f64> = raw
        .split(',')
        .map(|p| p.trim().parse::<f64>().unwrap_or(f64::NAN))
        .collect();
    let (dx, dy) = if parts.len() == 2 {
        (parts[0], parts[1])
    } else {
        (0.0, parts.first().copied().unwrap_or(f64::NAN))
    };
    let (dx, dy) = (
        if dx.is_finite() { dx } else { 0.0 },
        if dy.is_finite() { dy } else { 0.0 },
    );
    page.mouse(
        "mouseWheel",
        x,
        y,
        json!({"deltaX":dx,"deltaY":dy,"modifiers":modifier_mask(&step_modifiers(step))}),
    )
    .await
}

/// A held-button drag through the step's path; released on every exit.
pub(crate) async fn drag(page: &Page, source: &Value, step: &Value, epoch: u64) -> Value {
    let modifiers = modifier_mask(&step_modifiers(step));
    let at = |v: &Value| (round(num(&v["x"], 0.0)), round(num(&v["y"], 0.0)));
    let start = at(source);
    let mut vertices: Vec<(f64, f64)> = source["path"]
        .as_array()
        .into_iter()
        .flatten()
        .map(at)
        .collect();
    vertices.push(at(&source["destination"]));
    let mut current = start;
    let _ = page
        .mouse(
            "mouseMoved",
            start.0,
            start.1,
            json!({"modifiers":modifiers}),
        )
        .await;
    let _ = page
        .mouse(
            "mousePressed",
            start.0,
            start.1,
            json!({"button":"left","buttons":1,"clickCount":1,"modifiers":modifiers}),
        )
        .await;
    let mut from = start;
    let mut outcome = json!({"status":"completed","hit":source["hit"],"destination":source["destination"]["hit"]});
    'path: for end in &vertices {
        let distance = (end.0 - from.0).hypot(end.1 - from.1);
        // A straight drag keeps eight held moves; path segments scale with length.
        let steps: u32 = if vertices.len() == 1 {
            8
        } else {
            (2..8)
                .find(|n| f64::from(*n) * 12.0 >= distance)
                .unwrap_or(8)
        };
        let moves = f64::from(steps);
        for n in 1..=steps {
            let fenced = page
                .shared
                .with_tab(&page.tab, |t| t.cancelled || t.epoch != epoch)
                .unwrap_or(true);
            if fenced {
                outcome = json!({"status":"unknown","reason":"control_changed"});
                break 'path;
            }
            let ratio = f64::from(n) / moves;
            let point = (
                round(from.0 + (end.0 - from.0) * ratio),
                round(from.1 + (end.1 - from.1) * ratio),
            );
            current = point;
            let _ = page
                .mouse(
                    "mouseMoved",
                    point.0,
                    point.1,
                    json!({"button":"left","buttons":1,"modifiers":modifiers}),
                )
                .await;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        from = *end;
    }
    let _ = page
        .mouse(
            "mouseReleased",
            current.0,
            current.1,
            json!({"button":"left","buttons":0,"clickCount":1,"modifiers":modifiers}),
        )
        .await;
    outcome
}

/// Clicks the page's own upload control; the chooser it opens receives the
/// approved workspace file once.
pub(crate) async fn upload(page: &Page, x: f64, y: f64, step: &Value) -> Value {
    let (sender, receiver) = oneshot::channel();
    let path = super::js::js_string(&step["value"]);
    page.shared.with_tab(&page.tab, |t| {
        t.upload = Some(Upload { path, done: sender });
    });
    if click(page, x, y, step).await.is_err() {
        page.shared.with_tab(&page.tab, |t| t.upload = None);
        return json!({"status":"unknown","reason":"dispatch_interrupted"});
    }
    let result = tokio::time::timeout(Duration::from_secs(5), receiver).await;
    page.shared.with_tab(&page.tab, |t| t.upload = None);
    match result {
        Ok(Ok(value)) => value,
        _ => json!({"status":"unknown","reason":"no_file_chooser"}),
    }
}

pub(crate) async fn navigate_history(page: &Page, action: &str) -> Result<(), String> {
    if action == "reload" {
        return page.send("Page.reload", json!({})).await.map(|_| ());
    }
    let history = page.send("Page.getNavigationHistory", json!({})).await?;
    let delta = if action == "back" { -1 } else { 1 };
    let index = history["currentIndex"].as_i64().unwrap_or(0) + delta;
    let entry = usize::try_from(index)
        .ok()
        .and_then(|i| history["entries"].get(i).cloned())
        .ok_or("no_history")?;
    page.send(
        "Page.navigateToHistoryEntry",
        json!({"entryId":entry["id"]}),
    )
    .await
    .map(|_| ())
}
