//! A worker returns through its steward's ordinary queue and existing lease.
use super::*;
pub(super) fn steward(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", &json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => call(
            step,
            "delegate_to_worker",
            &json!({"action_key":"Build marker","objective":"Build the requested marker","acceptance_criteria":["Marker built and checked"],"implementation_brief":"Write feature-marker.txt with corrected marker and report its evidence."}),
        ),
        _ => call(step, "wait_for_worker", &json!({})),
    }
}
pub(super) fn execute(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", &json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => call(
            step,
            "write_file",
            &json!({"path":"feature-marker.txt","content":"corrected marker"}),
        ),
        3 => {
            let view = native::view(body);
            let part = view["parts"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|part| part["status"] == "running")
                .unwrap();
            call(
                step,
                "work_apply",
                &native::apply(
                    body,
                    json!([{"op":"task.submit","task_id":native::task_id(body),"part_id":part["id"],"result_refs":["feature-marker.txt"],"evidence_refs":["feature-marker.txt"]}]),
                ),
            )
        }
        _ => message("The marker was built and checked."),
    }
}
pub(super) fn result(step: usize, body: &Value) -> Value {
    match step {
        0 => call(step, "work_read", &json!({"view":"tasks"})),
        1 => read_task(step, body),
        2 => call(
            step,
            "work_apply",
            &native::submit(body, "feature-marker.txt"),
        ),
        _ => message("The worker output was integrated and verified."),
    }
}
