//! `buildAssistantFooterMetaById` (`messageFooterMeta.ts`): the worked-for duration and the
//! finish time under each assistant answer, formatted in local time.
use std::collections::HashMap;

use butler_ds::ui::context::Lang;
use chrono::{DateTime, Local};

use super::assistant::FooterMeta;
use super::user::format_clock;
use crate::ui::i18n::worked_duration;
use crate::ui::source::wire::{MessageRecord, MessageRecordRole};

fn parse(value: Option<&str>) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|date| date.with_timezone(&Local))
}

/// `findTurnUserMessage`: the nearest user message before `index` of the same turn.
fn turn_user_message<'a>(
    messages: &'a [MessageRecord],
    index: usize,
    turn_id: Option<&str>,
) -> Option<&'a MessageRecord> {
    messages[..index].iter().rev().find(|candidate| {
        candidate.role == MessageRecordRole::User
            && (turn_id.is_none_or(str::is_empty) || candidate.turn_id.as_deref() == turn_id)
    })
}

/// The footer meta of every assistant message, by message id.
pub(super) fn footer_meta(messages: &[MessageRecord], lang: Lang) -> HashMap<String, FooterMeta> {
    let now = Local::now();
    messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role == MessageRecordRole::Assistant)
        .map(|(index, message)| {
            let user = turn_user_message(messages, index, message.turn_id.as_deref());
            let completed = parse(
                message
                    .updated_at
                    .as_deref()
                    .or(message.created_at.as_deref()),
            );
            let started = parse(
                user.and_then(|user| user.created_at.as_deref())
                    .or(message.created_at.as_deref()),
            );
            let meta = FooterMeta {
                duration_label: completed.zip(started).map(|(done, start)| {
                    let millis = (done - start).num_milliseconds();
                    worked_duration(lang, ((millis + 500) / 1000).max(0))
                }),
                time_label: completed.map(|done| format_clock(&done, lang, &now)),
            };
            (message.id.clone(), meta)
        })
        .collect()
}
