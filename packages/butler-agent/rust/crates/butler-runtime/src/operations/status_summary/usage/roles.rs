//! Role splits share the selected root's bounded scope/slot walk.
use super::super::buckets::Tokens;
use super::{UsageLogIndex, Window, complete};
use serde_json::{Value, json};
use std::collections::BTreeMap;
impl UsageLogIndex {
    /// The selected root's calls by role, and the sum of every role other
    /// than "main" (its subtasks), per token type.
    pub(in super::super) fn by_role(&self, window: Window<'_>) -> (Value, Value) {
        let mut roles = BTreeMap::<String, Tokens>::new();
        if let Some(scope) = window.scope {
            for (member, role) in self.owners.members(scope) {
                for (&start, slot) in self.scope_slots(&member, window) {
                    let tokens = roles.entry(role.to_string()).or_default();
                    if complete(start, window) {
                        tokens.merge(&slot.usage.tokens);
                    } else {
                        for row in self.matching_rows(&slot.rows, window) {
                            tokens.add(row);
                        }
                    }
                }
            }
        }
        let mut subtasks = Tokens::default();
        for (_, tokens) in roles.iter().filter(|(role, _)| role.as_str() != "main") {
            subtasks.merge(tokens);
        }
        let by_role = json!(
            roles
                .into_iter()
                .filter(|(_, tokens)| tokens.request_count > 0)
                .map(|(role, tokens)| (role, tokens.value()))
                .collect::<BTreeMap<_, _>>()
        );
        (by_role, subtasks.value())
    }
    pub(in super::super) fn delegated_slots(&self, window: Window<'_>) -> BTreeMap<i64, Tokens> {
        let mut slots = BTreeMap::<i64, Tokens>::new();
        if let Some(scope) = window.scope {
            for (member, role) in self.owners.members(scope) {
                if role.as_ref() == "main" {
                    continue;
                }
                for (&start, slot) in self.scope_slots(&member, window) {
                    let tokens = self.slot_tokens(start, &slot.rows, &slot.usage.tokens, window);
                    slots.entry(start).or_default().merge(&tokens);
                }
            }
        }
        slots
    }
}
