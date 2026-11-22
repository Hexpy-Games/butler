//! The tools of an activity step through the native shell (the dialog's "details" of a finished
//! child).
use super::driver::{SERIAL, SHOTS, Shell};
use super::observer_dialog::finished_child;
use super::popover_scroll::{anchor_y, layout};
use super::*;

/// The id of the phase activity (a model-authored decision) the stub child's checkpoint
/// "Comparing approaches" made. The tools the child then ran (two reads, a write, a delivery)
/// belong to it, as `projectTurnActivity` attaches a block's operations to the latest activity.
fn comparing_activity(rows: &[Value]) -> Option<String> {
    rows.iter()
        .find(|row| {
            row["work_decision_source"] == "model-authored"
                && row["work_decision_summary"]
                    .as_str()
                    .is_some_and(|summary| summary.contains("Comparing approaches"))
        })
        .and_then(|row| row["id"].as_str().map(str::to_owned))
}

/// `{anchor, x, y, w, h}` of `anchor` in a layout the harness wrote.
fn bounds(layout: &Value, anchor: &str) -> [f64; 4] {
    let entry = layout
        .as_array()
        .and_then(|all| all.iter().find(|entry| entry["anchor"] == anchor))
        .unwrap_or_else(|| panic!("{anchor} is not in {layout}"));
    ["x", "y", "w", "h"].map(|key| entry[key].as_f64().expect("number"))
}

/// SHELL-APP-14 — The tools of a step listed in the activity dialog read as in Electron's
/// `WorkActivityToolGroup`: several tools are one control that opens their list, a click on a tool
/// opens its details under it, and neither the hover on the control nor the opening moves what is
/// above or beside it; in an open card's activity details a wheel moves only the details; a
/// trackpad gesture and its momentum that reach the details' end stop there; the next gesture
/// moves the conversation.
#[tokio::test]
async fn shell_app_14_a_steps_tools_group_and_open_their_details() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let (mut sandbox, chat, child) = finished_child("SHELL-APP-14").await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell.run(&["agent running"]).await?;
    let view = gateway(&shell.launch)
        .get(&format!("/session-view?session_id={}", child.session))
        .await?;
    let rows = view.data()["latest_turn"]["progress"]["safe_progress_rows"]
        .as_array()
        .expect("progress rows")
        .clone();
    let activity = comparing_activity(&rows)
        .unwrap_or_else(|| panic!("no comparing activity: {}", Value::Array(rows.clone())));
    let (row, open) = (
        format!("wait-anchor sidebar-row-{chat}"),
        format!("open {chat}"),
    );
    let sid = &child.session;
    let det = format!("work-details-{sid}");
    let edge = format!("work-details-edge-{sid}");
    let act = format!("activity-{activity}");
    shell
        .run(&[
            &row,
            &open,
            "size 900 600",
            &format!("wait-anchor steward-disclosure-{sid}"),
            &format!("reveal steward-disclosure-{sid} chat-transcript"),
            &format!("click steward-disclosure-{sid}"),
            &format!("wait-anchor {det}"),
            &format!("click {act}-group-button"),
            &format!("wait-anchor {act}-group-row-0"),
            &format!("click {act}-group-row-0"),
            "wait 500",
            &format!("reveal {det} chat-transcript"),
            &format!("expect-anchor {edge}:start"),
        ])
        .await?;
    activity_details_scroll(&mut shell, &det, &edge).await?;
    shell
        .run(&[
            &format!("reveal steward-disclosure-{sid} chat-transcript"),
            &format!("click-at steward-disclosure-{sid} 0.5 0.02"),
            &format!("wait-no-anchor {det}"),
        ])
        .await?;
    activity_dialog(&mut shell, sid, &child.turn, &activity).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

async fn activity_details_scroll(
    shell: &mut Shell,
    det: &str,
    edge: &str,
) -> Result<(), HarnessError> {
    let a0 = layout(shell, "a0", det).await?;
    shell
        .run(&[&format!("wheel {det} 60 0.5 0.3"), "wait 500"])
        .await?;
    let a1 = layout(shell, "a1", det).await?;
    let control = anchor_y(&a1, det).expect("details y") - anchor_y(&a0, det).expect("details y");
    shell
        .run(&[
            &format!("wheel {det} -20 0.5 0.3"),
            "wait 500",
            &format!("expect-anchor {edge}:middle"),
        ])
        .await?;
    let a2 = layout(shell, "a2", det).await?;
    let inner = anchor_y(&a2, det).expect("details y") - anchor_y(&a1, det).expect("details y");
    shell
        .run(&[
            &format!("wheel {det} -10 0.5 0.3 started"),
            &format!("wheel {det} -2000 0.5 0.3 moved"),
            &format!("wheel {det} -100 0.5 0.3 moved"),
            &format!("wheel {det} 0 0.5 0.3 ended"),
            &format!("wheel {det} -300 0.5 0.3 momentum"),
            &format!("wheel {det} -300 0.5 0.3 momentum"),
            "wait 500",
            &format!("expect-anchor {edge}:end"),
        ])
        .await?;
    let a3 = layout(shell, "a3", det).await?;
    let fling = anchor_y(&a3, det).expect("details y") - anchor_y(&a2, det).expect("details y");
    shell
        .run(&[
            &format!("wheel {det} -10 0.5 0.3 started"),
            &format!("wheel {det} -40 0.5 0.3 moved"),
            &format!("wheel {det} 0 0.5 0.3 ended"),
            "wait 500",
        ])
        .await?;
    let a4 = layout(shell, "a4", det).await?;
    let next = anchor_y(&a4, det).expect("details y") - anchor_y(&a3, det).expect("details y");
    let measured = format!(
        "chat movement: control {control}; inner wheel {inner}; fling and momentum {fling}; \
         next gesture {next}"
    );
    println!("SHELL-APP-14 {measured}");
    let mut failed = Vec::new();
    if control <= 20. {
        failed.push("(control) the wheel the details could not follow did not move the chat");
    }
    if inner.abs() > 0.5 {
        failed.push("the wheel in the details moved the chat");
    }
    if fling.abs() > 0.5 {
        failed.push("the gesture or its momentum moved the chat at the details' end");
    }
    if next >= -5. {
        failed.push("the next gesture did not move the chat toward its end");
    }
    assert!(failed.is_empty(), "{failed:?}: {measured}");
    Ok(())
}

async fn activity_dialog(
    shell: &mut Shell,
    sid: &str,
    turn: &str,
    activity: &str,
) -> Result<(), HarnessError> {
    let eye = format!("steward-observer-open-{sid}");
    let timeline = format!("turn-activity-{turn}");
    let group = format!("activity-{activity}-group-button");
    let tool = |index: usize| format!("activity-{activity}-group-row-{index}");
    shell
        .run(&[
            "size 800 1400",
            &format!("wait-anchor {eye}"),
            &format!("click {eye}"),
            "wait-anchor steward-observer-transcript",
            &format!("wait-anchor {timeline}"),
            // The timeline's header, "활동 · 완료 · N개 기록", opens the step list.
            &format!("click-at {timeline} 0.03 0.5"),
            &format!("wait-anchor {group}"),
            // Collapsed, the group lists no tool.
            &format!("expect-no-anchor {}", tool(0)),
            &format!("layout rest {group} {timeline}"),
            &format!("hover {group}"),
            &format!("layout hovered {group} {timeline}"),
            &format!("click {group}"),
            &format!("wait-anchor {}", tool(0)),
            &format!("wait-anchor {}", tool(1)),
            // The list folds open over the motion's duration; no harness command waits for that.
            "wait 500",
            &format!("layout listed {group} {} {}", tool(0), tool(1)),
            &format!("click {}", tool(0)),
            "wait 500",
            &format!("layout detailed {group} {} {}", tool(0), tool(1)),
            "app-quit",
        ])
        .await?;
    assert_activity_dialog(shell, activity)
}

fn assert_activity_dialog(shell: &Shell, activity: &str) -> Result<(), HarnessError> {
    let group = format!("activity-{activity}-group-button");
    let tool = |index: usize| format!("activity-{activity}-group-row-{index}");
    let rest = shell.report("rest.layout")?;
    let hovered = shell.report("hovered.layout")?;
    assert_eq!(
        bounds(&rest, &group),
        bounds(&hovered, &group),
        "the hover moved the group control\n{rest}\n{hovered}"
    );
    let (listed, detailed) = (
        shell.report("listed.layout")?,
        shell.report("detailed.layout")?,
    );
    let (group_at, first, second) = (
        bounds(&listed, &group),
        bounds(&listed, &tool(0)),
        bounds(&listed, &tool(1)),
    );
    // Electron's pill hugs its text (`width: fit-content`); the rows are as wide as the column.
    assert!(
        group_at[2] < first[2],
        "the group control is as wide as the column\n{listed}"
    );
    assert!(
        first[1] >= group_at[1] + group_at[3] && second[1] >= first[1] + first[3],
        "the tools are not listed under the control, in order\n{listed}"
    );
    let (group_after, first_after, second_after) = (
        bounds(&detailed, &group),
        bounds(&detailed, &tool(0)),
        bounds(&detailed, &tool(1)),
    );
    // The dialog is centred and grows with the details, so what stays is the list itself: the
    // control and the opened row keep their sizes and their distance, the next row moves down.
    assert_eq!(
        group_at[2..],
        group_after[2..],
        "opening a tool resized the control"
    );
    assert_eq!(
        first[2..],
        first_after[2..],
        "opening a tool resized its own row"
    );
    assert_eq!(
        first[1] - group_at[1],
        first_after[1] - group_after[1],
        "opening a tool moved its row against the control\n{listed}\n{detailed}"
    );
    assert!(
        second_after[1] - first_after[1] > second[1] - first[1] + 4.,
        "the details did not open under the tool: {second:?} -> {second_after:?}"
    );
    Ok(())
}
