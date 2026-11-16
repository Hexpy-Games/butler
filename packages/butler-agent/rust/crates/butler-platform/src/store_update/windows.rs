use ::windows::{
    ApplicationModel::Package,
    Services::Store::{StoreContext, StorePackageUpdateState},
};

use super::StoreUpdateError;

impl From<::windows::core::Error> for StoreUpdateError {
    fn from(error: ::windows::core::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

pub(super) fn check() -> Result<Option<String>, StoreUpdateError> {
    let context = StoreContext::GetDefault()?;
    let product = context.GetStoreProductForCurrentAppAsync()?.join()?;
    let hresult = product.ExtendedError()?;
    if hresult.is_err() || product.Product().is_err() {
        return Err(if hresult.0 as u32 == 0x803F6107 {
            StoreUpdateError::NotFromStore
        } else {
            StoreUpdateError::Failed(format!(
                "store product lookup failed: {:#010x}",
                hresult.0 as u32
            ))
        });
    }
    let family = Package::Current()?.Id()?.FamilyName()?;
    let updates = context
        .GetAppAndOptionalStorePackageUpdatesAsync()?
        .join()?;
    for update in updates {
        let id = update.Package()?.Id()?;
        if id.FamilyName()? == family {
            let version = id.Version()?;
            return Ok(Some(format!(
                "{}.{}.{}",
                version.Major, version.Minor, version.Build
            )));
        }
    }
    Ok(None)
}

pub(super) fn download() -> Result<(), StoreUpdateError> {
    let context = StoreContext::GetDefault()?;
    let updates = context
        .GetAppAndOptionalStorePackageUpdatesAsync()?
        .join()?;
    if updates.Size()? == 0 {
        return Err(StoreUpdateError::Failed(
            "no Store update is available".into(),
        ));
    }
    if !context.CanSilentlyDownloadStorePackageUpdates()? {
        return Err(StoreUpdateError::Failed(
            "silent Store download is unavailable (Store auto-update off or metered network)"
                .into(),
        ));
    }
    let state = context
        .TrySilentDownloadStorePackageUpdatesAsync(&updates)?
        .join()?
        .OverallState()?;
    if state != StorePackageUpdateState::Completed {
        return Err(StoreUpdateError::Failed(format!(
            "Store download ended in state {}",
            state.0
        )));
    }
    Ok(())
}

pub(super) fn install() -> Result<(), StoreUpdateError> {
    let context = StoreContext::GetDefault()?;
    let updates = context
        .GetAppAndOptionalStorePackageUpdatesAsync()?
        .join()?;
    if updates.Size()? == 0 {
        return Err(StoreUpdateError::Failed(
            "no Store update is available".into(),
        ));
    }
    let state = context
        .TrySilentDownloadAndInstallStorePackageUpdatesAsync(&updates)?
        .join()?
        .OverallState()?;
    if state != StorePackageUpdateState::Completed {
        return Err(StoreUpdateError::Failed(format!(
            "Store install ended in state {}",
            state.0
        )));
    }
    Ok(())
}

pub(super) fn app_user_model_id() -> Result<String, StoreUpdateError> {
    Ok(Package::Current()?
        .GetAppListEntries()?
        .GetAt(0)?
        .AppUserModelId()?
        .to_string())
}
