//! Quota identities may carry a provider-defined prefix before the generic code.
pub(super) fn matches(identity: &str, values: &[&str]) -> bool {
    identity.split_whitespace().any(|token| {
        let token = token.trim_matches('_');
        values.iter().any(|value| {
            token
                .strip_suffix(value)
                .is_some_and(|prefix| prefix.is_empty() || prefix.ends_with('_'))
        })
    })
}
