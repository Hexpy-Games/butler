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

/// [`anchor`] for a control: `<name>` while it takes clicks, `<name>-disabled` while it does not
/// (Electron's `:not(:disabled)`), so a harness step waits until the control is usable.
pub(crate) fn control_anchor<E: InteractiveElement>(el: E, name: &str, enabled: bool) -> E {
    #[cfg(feature = "shots")]
    {
        if enabled {
            anchor(el, name)
        } else {
            anchor(el, &format!("{name}-disabled"))
        }
    }
    #[cfg(not(feature = "shots"))]
    {
        let _ = (name, enabled);
        el
    }
}
