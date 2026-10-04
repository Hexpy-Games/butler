use butler_e2e::e2e::HarnessError;

pub(super) async fn assert_delegated_files(
    s: &butler_e2e::e2e::scenario::Scenario,
) -> Result<(), HarnessError> {
    let messages = s.gw.messages("general").await?;
    let answer = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "assistant")
        .unwrap();
    let changed = answer["changed_files"].as_array().unwrap();
    assert_eq!(changed.len(), 1, "{answer}");
    assert_eq!(changed[0]["path"], "report.html");
    assert_eq!(changed[0]["additions"], 2);
    let artifacts = answer["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1, "{answer}");
    assert_eq!(artifacts[0]["title"], "report.html");
    let view = s.gw.get("/session-view?session_id=general").await?;
    let rows = view.data()["steward_children"][0]["latest_turn"]["progress"]["safe_progress_rows"]
        .as_array()
        .unwrap()
        .clone();
    let write = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "write_file")
        .unwrap();
    assert_eq!(write["safe_input_label"], "report.html");
    Ok(())
}
