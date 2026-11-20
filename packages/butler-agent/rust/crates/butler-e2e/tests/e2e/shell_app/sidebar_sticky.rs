//! The sidebar's sticky headers hold while the tree scrolls, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// The top edge of `anchor` in the `name` layout report.
fn top(shell: &Shell, name: &str, anchor: &str) -> f64 {
    let report = shell
        .report(&format!("{name}.layout"))
        .expect("layout report");
    report
        .as_array()
        .expect("layout array")
        .iter()
        .find(|entry| entry["anchor"] == anchor)
        .and_then(|entry| entry["y"].as_f64())
        .unwrap_or_else(|| panic!("{anchor} missing in {name}"))
}

/// Keys of the group's children in sidebar order.
fn children(space: &Value, group: &str) -> Vec<String> {
    let mut nodes: Vec<&Value> = space["nodes"]
        .as_array()
        .expect("space nodes")
        .iter()
        .filter(|node| node["parentKey"] == group)
        .collect();
    nodes.sort_by(|a, b| {
        let at = |node: &Value| node["position"].as_f64().unwrap_or_default();
        at(a).total_cmp(&at(b))
    });
    nodes
        .iter()
        .filter_map(|node| node["key"].as_str().map(str::to_owned))
        .collect()
}

/// SHELL-APP-22 — While the sidebar tree scrolls under a wheel (small steps, then one large
/// step), the sticky header (the view tabs) and the header of the group being scrolled through
/// hold their place once pinned, and the rows move under them. Owner report 2026-11-18: the
/// pinned area shook while the sidebar scrolled.
#[tokio::test]
async fn shell_app_22_sidebar_sticky_headers_hold_while_scrolling() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-22")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer", "size 1000 700"])
        .await?;
    let gw = gateway(&shell.launch);
    let revision = |space: &Value| space["revision"].clone();
    let space = gw.get("/navigation").await?.data()["space"].clone();
    let created = gw
        .post(
            "/space/groups",
            json!({"expectedRevision": revision(&space), "title": "Sticky", "parentKey": null}),
        )
        .await?;
    assert_eq!(created.status, 200, "{}", created.text);
    let group_id = created.data()["groupId"]
        .as_str()
        .expect("group id")
        .to_owned();
    let group = format!("g:{group_id}");
    for n in 0..30 {
        let session = gw
            .post(
                "/sessions",
                json!({"kind": "chat", "title": format!("Sticky {n}")}),
            )
            .await?;
        assert_eq!(session.status, 201, "{}", session.text);
        let key = format!(
            "s:{}",
            session.data()["session"]["id"].as_str().expect("id")
        );
        let space = gw.get("/navigation").await?.data()["space"].clone();
        let moved = gw
            .post(
                "/space/moves",
                json!({"expectedRevision": revision(&space), "sourceKey": key,
                    "targetKey": group, "position": "inside"}),
            )
            .await?;
        assert_eq!(moved.status, 200, "{}", moved.text);
    }
    let space = gw.get("/navigation").await?.data()["space"].clone();
    let rows: Vec<String> = children(&space, &group)
        .iter()
        .map(|key| format!("sidebar-row-{}", key.trim_start_matches("s:")))
        .collect();
    assert_eq!(rows.len(), 30, "{space}");
    let last = rows[29].trim_start_matches("sidebar-row-").to_owned();
    // Opening the last child shows every child of the group.
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{group_id}"),
            &format!("open {last}"),
            &format!("wait-anchor {}", rows[29]),
            "wait 600",
        ])
        .await?;
    let tabs = "sidebar-tabs";
    let header = format!("sidebar-group-actions-{group_id}");
    // Capture 0 rests at the top; 1-5 are wheel steps of two rows; 6 is one large step.
    let steps = [0, 6, 8, 10, 12, 14, 29];
    for (n, row) in steps.iter().enumerate() {
        shell
            .run(&[
                &format!("reveal {} slot:sidebar-scroll:frame", rows[*row]),
                &format!("layout s{n} {tabs} {header} slot:sidebar-scroll:frame"),
            ])
            .await?;
    }
    shell.run(&["app-quit"]).await?;
    let series: Vec<(f64, f64)> = (0..steps.len())
        .map(|n| {
            (
                top(&shell, &format!("s{n}"), tabs),
                top(&shell, &format!("s{n}"), &header),
            )
        })
        .collect();
    println!("SHELL-APP-22 (tabs y, group header y) per capture: {series:?}");
    let (tabs_y, header_y) = series[1];
    // (a) At rest the tabs sit lower, at their place in the tree: the steps did pin them.
    assert!(top(&shell, "s0", tabs) > tabs_y + 0.5, "tabs did not pin");
    assert!(header_y > tabs_y, "{header_y} {tabs_y}");
    for n in 1..steps.len() {
        let name = format!("s{n}");
        // (b) The tabs and the group header hold their place on every step.
        let (t, h) = (top(&shell, &name, tabs), top(&shell, &name, &header));
        assert!(
            (t - tabs_y).abs() <= 0.5 && (h - header_y).abs() <= 0.5,
            "{name}: tabs {t} (pinned {tabs_y}), group header {h} (pinned {header_y})"
        );
        // (c) The rows moved under them: the row the last step centred went up.
        let previous = format!("s{}", n - 1);
        let row = &rows[steps[n - 1]];
        let (before, after) = (top(&shell, &previous, row), top(&shell, &name, row));
        assert!(after < before - 1., "{row}: {before} -> {after}");
    }
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
