//! The screenshot harness's geometry selector.
use gpui::InteractiveElement;

/// Stable geometry selector for the screenshot harness.
pub(crate) fn anchor<E: InteractiveElement>(el: E, name: &str) -> E {
    #[cfg(feature = "shots")]
    {
        el.debug_selector(|| name.to_owned())
    }
    #[cfg(not(feature = "shots"))]
    {
        let _ = name;
        el
    }
}
