//! The OS display accessibility settings Liquid Glass follows: Reduce Transparency and
//! Increase Contrast. macOS asks `NSWorkspace`; other systems report both off.

/// The two display settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DisplayAccessibility {
    /// Reduce Transparency is on: glass frosts more.
    pub reduce_transparency: bool,
    /// Increase Contrast is on: glass is near-opaque with a full-strength edge.
    pub increase_contrast: bool,
}

/// The current settings (cheap; read on the main thread each frame).
#[cfg(target_os = "macos")]
pub fn read() -> DisplayAccessibility {
    use objc2_app_kit::NSWorkspace;
    let workspace = NSWorkspace::sharedWorkspace();
    DisplayAccessibility {
        reduce_transparency: workspace.accessibilityDisplayShouldReduceTransparency(),
        increase_contrast: workspace.accessibilityDisplayShouldIncreaseContrast(),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read() -> DisplayAccessibility {
    DisplayAccessibility::default()
}
