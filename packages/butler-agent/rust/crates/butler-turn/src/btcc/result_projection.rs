//! Request-local identities for delegated result projections.
use std::collections::HashSet;

#[derive(Default)]
pub struct ResultProjection {
    seen: HashSet<String>,
}

impl ResultProjection {
    pub fn result_id(text: &str) -> Option<&str> {
        text.strip_prefix("Delegated result\nresult_id: ")?
            .lines()
            .next()
    }

    pub fn remember(&mut self, id: &str) {
        self.seen.insert(id.to_owned());
    }

    pub fn contains(&self, id: &str) -> bool {
        self.seen.contains(id)
    }

    pub fn project(&mut self, text: &str) -> String {
        let Some(id) = Self::result_id(text) else {
            return text.into();
        };
        if self.seen.insert(id.to_owned()) {
            text.into()
        } else {
            Self::reference(id)
        }
    }

    pub fn reference(id: &str) -> String {
        format!(
            "(result {}, shown above)",
            id.chars().take(19).collect::<String>()
        )
    }
}
