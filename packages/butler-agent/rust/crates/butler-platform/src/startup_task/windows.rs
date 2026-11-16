use ::windows::ApplicationModel::{StartupTask, StartupTaskState as WindowsState};

use super::StartupTaskState;

fn task() -> Result<StartupTask, String> {
    let tasks = StartupTask::GetForCurrentPackageAsync()
        .and_then(|operation| operation.join())
        .map_err(|error| error.to_string())?;
    let count = tasks.Size().map_err(|error| error.to_string())?;
    if count != 1 {
        return Err(format!(
            "expected exactly one package startup task, found {count}"
        ));
    }
    tasks.GetAt(0).map_err(|error| error.to_string())
}

fn mapped(state: WindowsState) -> Result<StartupTaskState, String> {
    match state {
        WindowsState::Enabled => Ok(StartupTaskState::Enabled),
        WindowsState::Disabled => Ok(StartupTaskState::Disabled),
        WindowsState::DisabledByUser => Ok(StartupTaskState::DisabledByUser),
        WindowsState::DisabledByPolicy => Ok(StartupTaskState::DisabledByPolicy),
        WindowsState::EnabledByPolicy => Ok(StartupTaskState::EnabledByPolicy),
        other => Err(format!("unknown package startup task state: {}", other.0)),
    }
}

pub(super) fn state() -> Result<StartupTaskState, String> {
    mapped(task()?.State().map_err(|error| error.to_string())?)
}

pub(super) fn set(enabled: bool) -> Result<StartupTaskState, String> {
    let task = task()?;
    let state = if enabled {
        task.RequestEnableAsync()
            .and_then(|operation| operation.join())
            .map_err(|error| error.to_string())?
    } else {
        task.Disable().map_err(|error| error.to_string())?;
        task.State().map_err(|error| error.to_string())?
    };
    mapped(state)
}
