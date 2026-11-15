//! The OS display accessibility settings Liquid Glass follows: Reduce Transparency and
//! Increase Contrast, and Reduce Motion. macOS and Windows read the OS; Linux reports off.

/// The display settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DisplayAccessibility {
    /// Reduce Transparency is on: glass frosts more.
    pub reduce_transparency: bool,
    /// Increase Contrast is on: glass is near-opaque with a full-strength edge.
    pub increase_contrast: bool,
    /// Reduce Motion is on: non-essential animation holds still.
    pub reduce_motion: bool,
}

/// The current settings (cheap; read on the main thread each frame).
#[cfg(target_os = "macos")]
pub fn read() -> DisplayAccessibility {
    use objc2_app_kit::NSWorkspace;
    let workspace = NSWorkspace::sharedWorkspace();
    DisplayAccessibility {
        reduce_transparency: workspace.accessibilityDisplayShouldReduceTransparency(),
        increase_contrast: workspace.accessibilityDisplayShouldIncreaseContrast(),
        reduce_motion: workspace.accessibilityDisplayShouldReduceMotion(),
    }
}

/// The current settings from Windows Animation effects.
#[cfg(windows)]
pub fn read() -> DisplayAccessibility {
    DisplayAccessibility {
        reduce_motion: !windows::UI::ViewManagement::UISettings::new()
            .and_then(|settings| settings.AnimationsEnabled())
            .unwrap_or(true),
        reduce_transparency: false,
        increase_contrast: false,
    }
}

/// The current settings: off where the OS has no reader.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn read() -> DisplayAccessibility {
    DisplayAccessibility::default()
}
