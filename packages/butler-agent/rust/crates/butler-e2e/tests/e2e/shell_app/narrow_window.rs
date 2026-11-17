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
/// send button keeps its desktop size. At 700 px with no pane open the sidebar stays docked.
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
            &format!("layout info {anchors}"),
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
            "compose",
            "wait-anchor send-button",
            &format!("layout docked700 {anchors}"),
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
    // (e) At 700 px with no pane open the sidebar stays docked, like Electron: it sits at the same
    // left inset as at 1200 px and the conversation starts to its right. The peek overlay has no
    // anchor, so a closed sidebar (which turns the peek on) shows as no `sidebar` anchor.
    let (docked, wide_sidebar) = (
        bounds(&shell, "docked700", "sidebar"),
        get("wide", "sidebar"),
    );
    let card = get("docked700", "chat-card");
    assert!(
        docked.is_some_and(|d| near(d[0], wide_sidebar[0]) && card[0] >= d[0] + d[2] - 0.5),
        "docked700 sidebar {docked:?}, wide sidebar {wide_sidebar:?}, chat card {card:?}"
    );
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
