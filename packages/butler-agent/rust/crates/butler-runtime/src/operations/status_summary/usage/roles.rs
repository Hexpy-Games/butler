//! Role splits share the selected root's bounded scope/slot walk.
use super::super::buckets::Tokens;
use super::{UsageLogIndex, Window, complete};
use serde_json::{Value, json};
use std::collections::BTreeMap;
impl UsageLogIndex {
    pub(in super::super) fn by_role(&self, window: Window<'_>) -> Value {
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
        json!(
            roles
                .into_iter()
                .filter(|(_, tokens)| tokens.request_count > 0)
                .map(|(role, tokens)| (role, tokens.value()))
                .collect::<BTreeMap<_, _>>()
        )
    }
    pub(in super::super) fn delegated_slots(&self, window: Window<'_>) -> BTreeMap<i64, f64> {
        let mut slots = BTreeMap::<i64, f64>::new();
        if let Some(scope) = window.scope {
            for (member, role) in self.owners.members(scope) {
                if role.as_ref() == "main" {
                    continue;
                }
                for (&start, slot) in self.scope_slots(&member, window) {
                    let tokens = self.slot_tokens(start, &slot.rows, &slot.usage.tokens, window);
                    let total = tokens.prompt + tokens.output;
                    *slots.entry(start).or_default() += total;
                }
            }
        }
        slots
    }
}
