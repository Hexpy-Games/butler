//! The power signals animated wallpapers follow (Electron `butler-platform/power.mjs`):
//! whether the machine runs on battery, and whether it is thermally constrained.

/// The two power signals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PowerState {
    /// Running on battery power.
    pub on_battery: bool,
    /// Thermal pressure is serious or critical.
    pub constrained: bool,
}

/// The current state (one cheap OS query; no caching, no polling here).
#[cfg(target_os = "macos")]
pub fn read() -> PowerState {
    use objc2_foundation::{NSProcessInfo, NSProcessInfoThermalState};
    PowerState {
        on_battery: objc2_io_kit::IOPSGetTimeRemainingEstimate()
            != objc2_io_kit::kIOPSTimeRemainingUnlimited,
        constrained: matches!(
            NSProcessInfo::processInfo().thermalState(),
            NSProcessInfoThermalState::Serious | NSProcessInfoThermalState::Critical
        ),
    }
}

/// The current state (one cheap OS query; no caching, no polling here).
#[cfg(windows)]
pub fn read() -> PowerState {
    use windows::System::Power::{BatteryStatus, PowerManager};
    PowerState {
        on_battery: PowerManager::BatteryStatus()
            .is_ok_and(|status| status == BatteryStatus::Discharging),
        constrained: false,
    }
}

/// The current state (one cheap OS query; no caching, no polling here).
#[cfg(target_os = "linux")]
pub fn read() -> PowerState {
    let on_battery = std::fs::read_dir("/sys/class/power_supply")
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| {
            let path = entry.path();
            std::fs::read_to_string(path.join("type")).is_ok_and(|kind| kind.trim() == "Battery")
                && std::fs::read_to_string(path.join("status"))
                    .is_ok_and(|status| status.trim() == "Discharging")
        });
    PowerState {
        on_battery,
        constrained: false,
    }
}

/// The current state where the OS has no reader.
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub fn read() -> PowerState {
    PowerState::default()
}
