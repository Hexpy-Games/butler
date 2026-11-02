//! A bounded-context model script, with owner edits between two file reads.
use super::*;

pub(super) async fn call(
    script: &Script,
    round: usize,
    outputs: &[Value],
) -> (&'static str, Value) {
    if matches!(round, 3 | 5) {
        script.held.add_permits(1);
        script.release.acquire().await.unwrap().forget();
    }
    let epic = script.epics.lock().unwrap()[0].clone();
    match round {
        0 => (
            "replace_work_plan",
            json!({"objective":"Read all evidence","execution_mode":"direct","start_new":true,"governing_refs":[format!("canon:epic/{epic}")],"actions":[{"action_key":"read","description":"Read the evidence"}],"checks":["Evidence is read"]}),
        ),
        1 => (
            "record_work_review",
            json!({"subject":"plan","verdict":"accept","summary":"Covers the evidence"}),
        ),
        2..=10 => (
            "read_file",
            json!({"requests":[{"path":*script.path.lock().unwrap(),"max_bytes":60000,"limit_lines":10000}]}),
        ),
        11 => {
            let work = outputs
                .iter()
                .rev()
                .find_map(|value| value.pointer("/output/work/work_id"))
                .expect("the bound Work survives compaction");
            (
                "record_work_disposition",
                json!({"work_id":work,"disposition":"completed","summary":"Evidence read","action_updates":[{"action_key":"read","status":"done"}],"remaining_actions":[],"followups":[]}),
            )
        }
        _ => ("", Value::Null),
    }
}
