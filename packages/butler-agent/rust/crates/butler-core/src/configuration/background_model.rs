//! Model precedence shared by all background agent work.

/// Resolve a run without changing saved choices. Explicit item choices win;
/// a background choice is used only while selectable. The caller supplies
/// today's fallback (main model or the parent chat's model).
pub fn resolve_background_model<'a>(
    explicit: Option<&'a str>,
    background: Option<&'a str>,
    fallback: Option<&'a str>,
    selectable: impl FnOnce(&str) -> bool,
) -> Option<&'a str> {
    let chosen = |value: &&str| !value.trim().is_empty() && !matches!(*value, "default" | "butler");
    explicit
        .filter(chosen)
        .or_else(|| background.filter(chosen).filter(|value| selectable(value)))
        .or(fallback)
}
