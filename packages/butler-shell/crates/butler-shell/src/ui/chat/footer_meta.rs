//! `buildAssistantFooterMetaById` (`messageFooterMeta.ts`): the worked-for duration and the
//! finish time under each assistant answer, formatted in local time.
use std::collections::HashMap;
use std::sync::Arc;

use butler_ds::ui::context::Lang;
use chrono::{DateTime, Local, NaiveDate};

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
    messages: &'a [Arc<MessageRecord>],
    index: usize,
    turn_id: Option<&str>,
) -> Option<&'a Arc<MessageRecord>> {
    messages[..index].iter().rev().find(|candidate| {
        candidate.role == MessageRecordRole::User
            && (turn_id.is_none_or(str::is_empty) || candidate.turn_id.as_deref() == turn_id)
    })
}

/// The footer meta of one assistant message, given the user message that started its turn.
fn meta_of(
    message: &MessageRecord,
    user: Option<&MessageRecord>,
    lang: Lang,
    now: &DateTime<Local>,
) -> FooterMeta {
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
    FooterMeta {
        duration_label: completed.zip(started).map(|(done, start)| {
            let millis = (done - start).num_milliseconds();
            worked_duration(lang, ((millis + 500) / 1000).max(0))
        }),
        time_label: completed.map(|done| format_clock(&done, lang, now)),
    }
}

/// A message, its turn's user message, and the meta computed from them.
type Entry = (Arc<MessageRecord>, Option<Arc<MessageRecord>>, FooterMeta);

/// The footer meta of every assistant message, kept per message: one whose record and turn user
/// message are the same pointers as last time is not parsed or formatted again.
#[derive(Default)]
pub(super) struct FooterMetas {
    /// The language and local date the entries were formatted for (`format_clock` reads today).
    key: Option<(Lang, NaiveDate)>,
    entries: HashMap<String, Entry>,
}

impl FooterMetas {
    /// The footer meta of every assistant message of `messages`, by message id.
    pub(super) fn update(
        &mut self,
        messages: &[Arc<MessageRecord>],
        lang: Lang,
    ) -> HashMap<String, FooterMeta> {
        let now = Local::now();
        let key = Some((lang, now.date_naive()));
        if self.key != key {
            self.entries.clear();
            self.key = key;
        }
        let mut entries = HashMap::new();
        for (index, message) in messages.iter().enumerate() {
            if message.role != MessageRecordRole::Assistant {
                continue;
            }
            let user = turn_user_message(messages, index, message.turn_id.as_deref());
            let entry = self
                .entries
                .remove(&message.id)
                .filter(|(known, known_user, _)| {
                    Arc::ptr_eq(known, message)
                        && known_user.as_ref().map(Arc::as_ptr) == user.map(Arc::as_ptr)
                })
                .unwrap_or_else(|| {
                    let meta = meta_of(message, user.map(|user| &**user), lang, &now);
                    (message.clone(), user.cloned(), meta)
                });
            entries.insert(message.id.clone(), entry);
        }
        self.entries = entries;
        self.entries
            .iter()
            .map(|(id, (_, _, meta))| (id.clone(), meta.clone()))
            .collect()
    }
}
