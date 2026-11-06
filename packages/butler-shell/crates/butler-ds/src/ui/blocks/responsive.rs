//! Adaptive breakpoints (DS `responsive.ts`): the shell's panels dock beside the workspace or
//! become drawers over it, by the window width and the chrome environment.

/// The widest compact window (`max-width: 640px`).
pub const COMPACT_MAX: f32 = 640.; // DS: responsive.ts:6
/// The widest medium window (`max-width: 1023px`).
pub const MEDIUM_MAX: f32 = 1023.; // DS: responsive.ts:7

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChromeEnvironment {
    #[default]
    Browser,
    Electron,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdaptiveMode {
    Compact,
    Medium,
    Expanded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdaptivePanel {
    Left,
    Right,
}

/// Which panels are open.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PanelState {
    pub left_open: bool,
    pub right_open: bool,
}

/// The mode of a window `width` wide. The desktop app has no medium mode.
pub fn classify_adaptive_mode(width: f32, environment: ChromeEnvironment) -> AdaptiveMode {
    if width <= COMPACT_MAX {
        AdaptiveMode::Compact
    } else if environment == ChromeEnvironment::Electron || width > MEDIUM_MAX {
        AdaptiveMode::Expanded
    } else {
        AdaptiveMode::Medium
    }
}

/// Whether the panels are drawers at this width (`adaptiveDrawerQuery`).
pub fn drawer(width: f32, environment: ChromeEnvironment) -> bool {
    match environment {
        ChromeEnvironment::Electron => width <= COMPACT_MAX,
        ChromeEnvironment::Browser => width <= MEDIUM_MAX,
    }
}

/// Opening one panel: expanded keeps the other, narrower modes close it.
pub fn normalize_panel_state(
    mode: AdaptiveMode,
    requested: AdaptivePanel,
    state: PanelState,
) -> PanelState {
    match (mode == AdaptiveMode::Expanded, requested) {
        (true, AdaptivePanel::Left) => PanelState {
            left_open: true,
            ..state
        },
        (true, AdaptivePanel::Right) => PanelState {
            right_open: true,
            ..state
        },
        (false, AdaptivePanel::Left) => PanelState {
            left_open: true,
            right_open: false,
        },
        (false, AdaptivePanel::Right) => PanelState {
            left_open: false,
            right_open: true,
        },
    }
}

/// The panels a window restores to: only an expanded one keeps them.
pub fn restore_panel_state(mode: AdaptiveMode, state: PanelState) -> PanelState {
    if mode == AdaptiveMode::Expanded {
        state
    } else {
        PanelState::default()
    }
}
