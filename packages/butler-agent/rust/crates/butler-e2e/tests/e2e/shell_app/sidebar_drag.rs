//! Dragging a sidebar row opens a gap where it would land, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// An anchor's box (x, y, w, h) in the `name` layout report.
fn rect(shell: &Shell, name: &str, anchor: &str) -> [f64; 4] {
    let report = shell
        .report(&format!("{name}.layout"))
        .expect("layout report");
    let entry = report
        .as_array()
        .expect("layout array")
        .iter()
        .find(|entry| entry["anchor"] == anchor)
        .unwrap_or_else(|| panic!("{anchor} missing in {name}"));
    ["x", "y", "w", "h"].map(|k| entry[k].as_f64().expect("layout number"))
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

/// How far down (window px) the pixels of `box_` at rest were drawn in `held`: the offset whose
/// strip in `held` differs least from the strip in `rest` (a row slides as a whole). Only the
/// box's start half is compared: the drag preview follows the pointer at the rows' end.
fn travelled(rest: &image::RgbaImage, held: &image::RgbaImage, box_: [f64; 4], scale: f64) -> f64 {
    let [x, y, w, h] = box_.map(|v| v * scale);
    let w = w / 2.;
    let within = |v: u32, from: f64, size: f64| f64::from(v) >= from && f64::from(v) < from + size;
    let xs: Vec<u32> = (0..rest.width()).filter(|&v| within(v, x, w)).collect();
    let ys: Vec<u32> = (0..rest.height()).filter(|&v| within(v, y, h)).collect();
    let mut best = (u64::MAX, 0_i64);
    for offset in -40_i64..=160 {
        let mut diff = 0_u64;
        for &row in &ys {
            let Ok(moved) = u32::try_from(i64::from(row) + offset) else {
                diff = u64::MAX;
                break;
            };
            if moved >= held.height() {
                diff = u64::MAX;
                break;
            }
            for &col in &xs {
                let (a, b) = (rest.get_pixel(col, row).0, held.get_pixel(col, moved).0);
                diff += (0..3).map(|c| u64::from(a[c].abs_diff(b[c]))).sum::<u64>();
            }
        }
        if diff < best.0 {
            best = (diff, offset);
        }
    }
    f64::from(i32::try_from(best.1).expect("small offset")) / scale
}

/// SHELL-APP-23 — Dragging the last row of a group over the top edge of its second row opens a
/// one-row gap there while the drop is pending: the second row and every row after it, in the
/// group and after it (the next folder), slide down by the gap and the first row stays; the
/// target never covers the row below it. Releasing moves the row there. Owner report
/// 2026-11-18: the row below the drop point vanished under the target instead of moving, and
/// the drag dropped frames.
#[tokio::test]
async fn shell_app_23_sidebar_drag_opens_a_gap_and_reorders() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-23")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer", "size 1000 800"])
        .await?;
    let gw = gateway(&shell.launch);
    let revision = |space: &Value| space["revision"].clone();
    let mut groups = Vec::new();
    for title in ["Drag", "After"] {
        let space = gw.get("/navigation").await?.data()["space"].clone();
        let created = gw
            .post(
                "/space/groups",
                json!({"expectedRevision": revision(&space), "title": title, "parentKey": null}),
            )
            .await?;
        assert_eq!(created.status, 200, "{}", created.text);
        groups.push(created.data()["groupId"].as_str().expect("id").to_owned());
    }
    let (group, after) = (format!("g:{}", groups[0]), format!("g:{}", groups[1]));
    let space = gw.get("/navigation").await?.data()["space"].clone();
    let placed = gw
        .post(
            "/space/moves",
            json!({"expectedRevision": revision(&space), "sourceKey": after,
                "targetKey": group, "position": "after"}),
        )
        .await?;
    assert_eq!(placed.status, 200, "{}", placed.text);
    for (title, parent) in [
        ("Alpha", &group),
        ("Bravo", &group),
        ("Charlie", &group),
        ("Delta", &group),
        ("Echo", &after),
    ] {
        let session = gw
            .post("/sessions", json!({"kind": "chat", "title": title}))
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
                    "targetKey": parent, "position": "inside"}),
            )
            .await?;
        assert_eq!(moved.status, 200, "{}", moved.text);
    }
    let space = gw.get("/navigation").await?.data()["space"].clone();
    let keys = children(&space, &group);
    assert_eq!(keys.len(), 4, "{space}");
    let rows: Vec<String> = keys
        .iter()
        .map(|key| format!("sidebar-row-{}", key.trim_start_matches("s:")))
        .collect();
    let folder = format!("sidebar-row-{}", groups[1]);
    let anchors = format!("{} {folder}", rows.join(" "));
    // At rest, then dragging the last row onto the top edge of the second (its before zone). The
    // press is at the row's start and the pointer ends at the target's end, so the drag preview
    // (held where the press was) sits beside the rows' labels, not over them.
    shell
        .run(&[
            &format!("wait-anchor {}", rows[3]),
            &format!("wait-anchor {folder}"),
            "hover composer",
            "shot rest",
            &format!("layout rest {anchors}"),
            &format!("drag-hold {} 0.02 0.5 {} 0.98 0.1", rows[3], rows[1]),
            "shot held",
            &format!("drag-release {} 0.98 0.1", rows[1]),
        ])
        .await?;
    let shots = sandbox.root.join("shell");
    let rest = image::open(shots.join("rest.png")).expect("shot").to_rgba8();
    let held = image::open(shots.join("held.png")).expect("shot").to_rgba8();
    let scale = f64::from(rest.width()) / 1000.;
    let at = |anchor: &str| rect(&shell, "rest", anchor);
    // The gap: one row and the row spacing, the pitch of the group's rows.
    let gap = at(&rows[1])[1] - at(&rows[0])[1];
    let moved: Vec<f64> = [&rows[0], &rows[1], &rows[2], &folder]
        .iter()
        .map(|anchor| travelled(&rest, &held, at(anchor), scale))
        .collect();
    println!("SHELL-APP-23 gap {gap}, travelled (first, target, next, folder): {moved:?}");
    assert!(moved[0].abs() <= 1., "the row before the gap moved: {moved:?}");
    for (name, value) in ["target", "next row", "next folder"].iter().zip(&moved[1..]) {
        assert!(
            (value - gap).abs() <= 1.,
            "{name} travelled {value}, gap {gap}: {moved:?}"
        );
    }
    let (target, next) = (at(&rows[1]), at(&rows[2]));
    assert!(
        target[1] + target[3] + moved[1] <= next[1] + moved[2] + 1.,
        "the target covers the next row: {moved:?}"
    );
    // The drop lands: the dragged row is second.
    let expected = vec![
        keys[0].clone(),
        keys[3].clone(),
        keys[1].clone(),
        keys[2].clone(),
    ];
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let space = gw.get("/navigation").await?.data()["space"].clone();
        if children(&space, &group) == expected {
            break;
        }
        assert!(Instant::now() < deadline, "order {:?}", children(&space, &group));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The sidebar shows the new order once the move's event lands.
    let y = |shell: &Shell, anchor: &str| rect(shell, "dropped", anchor)[1];
    let mut shown = false;
    for _ in 0..50 {
        shell
            .run(&["wait 100", &format!("layout dropped {anchors}")])
            .await?;
        shown = y(&shell, &rows[0]) < y(&shell, &rows[3])
            && y(&shell, &rows[3]) < y(&shell, &rows[1])
            && y(&shell, &rows[1]) < y(&shell, &rows[2]);
        if shown {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(shown, "the sidebar did not show the dropped order");
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
