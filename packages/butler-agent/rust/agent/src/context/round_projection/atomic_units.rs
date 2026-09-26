use std::collections::HashSet;
use std::ops::Range;

use crate::btcc::{BtccError, ModelRoundMessage, ModelRoundRole};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AtomicUnit {
    pub range: Range<usize>,
    pub mandatory: bool,
}

pub(super) fn build(messages: &[ModelRoundMessage]) -> Result<Vec<AtomicUnit>, BtccError> {
    if messages
        .first()
        .is_none_or(|message| message.role != ModelRoundRole::User)
    {
        return Err(error("turn_current_request_missing"));
    }
    let mut units = vec![AtomicUnit {
        range: 0..1,
        mandatory: true,
    }];
    let mut has_open_tool_calls = false;
    let mut index = 1;
    while index < messages.len() {
        let message = &messages[index];
        if message.role == ModelRoundRole::Tool {
            return Err(error("turn_tool_protocol_orphan"));
        }
        let calls = message.tool_calls.as_deref().unwrap_or(&[]);
        if message.role != ModelRoundRole::Assistant || calls.is_empty() {
            units.push(AtomicUnit {
                range: index..index + 1,
                mandatory: matches!(
                    message.request_segment_kind.as_deref(),
                    Some("phase_continuity" | "current_user_request")
                ),
            });
            index += 1;
            continue;
        }
        let call_ids: HashSet<&str> = calls.iter().map(|call| call.id.as_str()).collect();
        let mut cursor = index + 1;
        while messages
            .get(cursor)
            .is_some_and(|message| message.role == ModelRoundRole::Tool)
        {
            cursor += 1;
        }
        let mut result_ids = HashSet::new();
        for result in &messages[index + 1..cursor] {
            let Some(result_id) = result.tool_call_id.as_deref().filter(|id| !id.is_empty()) else {
                return Err(error("turn_tool_protocol_orphan"));
            };
            if !call_ids.contains(result_id) || !result_ids.insert(result_id) {
                return Err(error("turn_tool_protocol_orphan"));
            }
        }
        let mandatory = call_ids.iter().any(|call_id| !result_ids.contains(call_id));
        has_open_tool_calls |= mandatory;
        units.push(AtomicUnit {
            range: index..cursor,
            mandatory,
        });
        index = cursor;
    }
    apply_mandatory_rules(messages, &mut units, has_open_tool_calls);
    Ok(units)
}

fn apply_mandatory_rules(
    messages: &[ModelRoundMessage],
    units: &mut [AtomicUnit],
    has_open_tool_calls: bool,
) {
    if let [_, .., last] = units {
        last.mandatory = true;
    }
    if !has_open_tool_calls
        && let Some(unit) = units.iter_mut().rev().find(|unit| {
            messages[unit.range.clone()]
                .iter()
                .any(|message| message.role == ModelRoundRole::Tool)
        })
    {
        unit.mandatory = true;
    }
    mark_latest(units, messages, |message| {
        message.role == ModelRoundRole::User
    });
    mark_latest(units, messages, |message| {
        message.role == ModelRoundRole::User
            && message.request_segment_kind.as_deref() == Some("current_user_request")
    });
    mark_latest(units, messages, |message| {
        message.request_segment_kind.as_deref() == Some("project_ledger_and_work_authority")
    });
    let anchors = crate::btcc::latest_work_anchor_indices(messages);
    for unit in units {
        if anchors.iter().any(|index| unit.range.contains(index)) {
            unit.mandatory = true;
        }
    }
}

fn mark_latest(
    units: &mut [AtomicUnit],
    messages: &[ModelRoundMessage],
    predicate: impl Fn(&ModelRoundMessage) -> bool,
) {
    if let Some(unit) = units
        .iter_mut()
        .rev()
        .find(|unit| messages[unit.range.clone()].iter().any(&predicate))
    {
        unit.mandatory = true;
    }
}

fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}
