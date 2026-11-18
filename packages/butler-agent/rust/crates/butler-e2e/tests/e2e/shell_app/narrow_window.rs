//! A narrow App window keeps the desktop layout, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// One anchor's `[x, y, w, h]` from a `layout <name>` report.
fn bounds(shell: &Shell, name: &str, anchor: &str) -> Option<[f64; 4]> {
    let report = shell
        .report(&format!("{name}.layout"))
        .expect("layout report");
    let found = report
        .as_array()
        .expect("layout array")
        .iter()
        .find(|entry| entry["anchor"] == anchor)?;
    Some(["x", "y", "w", "h"].map(|key| found[key].as_f64().expect("number")))
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.5
}

/// SHELL-APP-10 — At 400 px wide the App never takes the phone form: the sidebar overlays at its
/// own panel width without moving the conversation, session info floats shorter than the space
/// between the titlebar and the composer, the command palette is as wide as at 1200 px, and the
/// send button keeps its desktop size.
#[tokio::test]
async fn shell_app_10_narrow_window_keeps_the_desktop_layout() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-10")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    for n in 0..30 {
        let filler = gw
            .post(
                "/sessions",
                json!({"kind": "chat", "title": format!("Filler {n}")}),
            )
            .await?;
        assert_eq!(filler.status, 201, "{}", filler.text);
    }
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Narrow"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-08"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    let anchors = "chat-card composer send-button sidebar sidebar-toggle titlebar inspector";
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
            "wait-anchor sidebar",
            "wait 600",
            "layout tall slot:sidebar-scroll slot:sidebar-scroll:frame",
        ])
        .await?;
    let report = shell.report("tall.layout")?;
    let last = report
        .as_array()
        .expect("layout array")
        .iter()
        .filter(|entry| {
            entry["anchor"]
                .as_str()
                .is_some_and(|a| a.starts_with("sidebar-row-"))
        })
        .max_by(|a, b| {
            a["y"]
                .as_f64()
                .unwrap_or(0.)
                .total_cmp(&b["y"].as_f64().unwrap_or(0.))
        })
        .and_then(|entry| entry["anchor"].as_str())
        .expect("a session row")
        .to_owned();
    shell
        .run(&[
            &format!("reveal {last} slot:sidebar-scroll:frame"),
            &format!("layout scrolled {last} slot:sidebar-scroll slot:sidebar-scroll:frame"),
            "size 400 700",
            "wait 600",
            "compose",
            "wait-anchor send-button",
            &format!("layout closed {anchors}"),
            "click sidebar-toggle",
            "wait-anchor sidebar",
            "wait 600",
            &format!("layout sidebar {anchors}"),
            "click sidebar-toggle",
            "wait-no-anchor sidebar",
            "wait-anchor session-info-toggle",
            "click session-info-toggle",
            "wait-anchor inspector",
            "wait 600",
            &format!("layout info {anchors} slot:conversation-aside-scroll slot:conversation-aside-scroll:frame"),
            "click session-context",
            "wait 600",
            &format!("layout infoopen {anchors} slot:conversation-aside-scroll slot:conversation-aside-scroll:frame"),
            "click session-info-toggle",
            "wait-no-anchor inspector",
            "key secondary-k",
            "expect-palette",
            "wait 600",
            &format!("layout palette400 {anchors} dialog-content"),
            "key escape",
            "size 1200 700",
            "wait 600",
            "compose",
            "wait-anchor send-button",
            &format!("layout wide {anchors}"),
            "key secondary-k",
            "expect-palette",
            "wait 600",
            &format!("layout palette1200 {anchors} dialog-content"),
            "key escape",
            "size 700 700",
            "wait 600",
            "browser-link https://example.com/",
            "wait-anchor browser-area",
            "wait 600",
            "layout split chat-card browser-area",
            "app-quit",
        ])
        .await?;
    let get = |name: &str, anchor: &str| {
        bounds(&shell, name, anchor).unwrap_or_else(|| panic!("{anchor} missing in {name}"))
    };
    // (a) The sidebar is its panel width (min(88vw, 320px)), and the conversation does not move.
    let panel = (400. * 0.88_f64).min(320.);
    let sidebar = get("sidebar", "sidebar");
    assert!(
        near(sidebar[2], panel),
        "sidebar {sidebar:?}, panel {panel}"
    );
    let (closed, open) = (get("closed", "chat-card"), get("sidebar", "chat-card"));
    assert!(
        near(closed[0], open[0]) && near(closed[2], open[2]),
        "{closed:?} {open:?}"
    );
    // (b) Session info floats above the composer, under the titlebar.
    let titlebar = get("info", "titlebar");
    let (info, composer) = (get("info", "inspector"), get("info", "composer"));
    assert!(
        info[1] >= titlebar[1] + titlebar[3] - 0.5,
        "{info:?} {titlebar:?}"
    );
    assert!(
        info[1] + info[3] <= composer[1] + 0.5,
        "{info:?} {composer:?}"
    );
    // (c) The palette stays the desktop dialog, not the phone's full-width top sheet: it keeps its
    // gutter at 400 px (its 1200 px width, 520, does not fit) and sits below the window's top edge.
    let (narrow, wide) = (
        get("palette400", "dialog-content"),
        get("palette1200", "dialog-content"),
    );
    assert!(
        narrow[0] > 0.
            && narrow[1] > 0.
            && near(narrow[2], 400. - 2. * narrow[0])
            && wide[2] > 400.,
        "{narrow:?} {wide:?}"
    );
    // (d) The send button has the same size at both widths.
    let (small, large) = (get("closed", "send-button"), get("wide", "send-button"));
    assert!(
        near(small[2], large[2]) && near(small[3], large[3]),
        "{small:?} {large:?}"
    );
    // (e) The sidebar tree scrolls: its scroll element is as tall as its frame, not as tall as its
    // rows, and a wheel over the tree brings the last row into the frame.
    let (tree, frame) = (
        get("tall", "slot:sidebar-scroll"),
        get("tall", "slot:sidebar-scroll:frame"),
    );
    let (before, after) = (get("tall", &last), get("scrolled", &last));
    let frame_bottom = frame[1] + frame[3];
    assert!(tree[3] <= frame[3] + 0.5, "{tree:?} {frame:?}");
    assert!(before[1] + before[3] > frame_bottom, "{before:?} {frame:?}");
    assert!(
        after[1] + after[3] <= frame_bottom + 0.5,
        "{after:?} {frame:?}"
    );
    // (f) A row inside the floating session info works: clicking the context row opens its usage,
    // which makes the panel taller.
    let (closed, open) = (get("info", "inspector"), get("infoopen", "inspector"));
    assert!(open[3] > closed[3] + 0.5, "{closed:?} {open:?}");
    // (g) With the browser pane beside the chat at 700 px, the chat keeps the width the web gives it,
    // max(340, min(room - 375, 400)), so the pane keeps its 375 px minimum. `room` is what the chat
    // column and the pane share: the chat column's width plus the pane's. The chat-card anchor is
    // inset by the card's 1 px border on each side.
    let (chat, pane) = (get("split", "chat-card"), get("split", "browser-area"));
    let chat_width = chat[2] + 2.;
    let room = chat_width + pane[2];
    let expected = (room - 375.).clamp(340., 400.);
    assert!(
        (chat_width - expected).abs() <= 1. && pane[2] >= room - chat_width - 0.5,
        "chat {chat:?}, pane {pane:?}, room {room}, expected chat {expected}"
    );
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
