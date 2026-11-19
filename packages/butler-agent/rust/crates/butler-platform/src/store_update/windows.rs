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

/// The Store's answer for a package with no Store product (sideloaded or unsubmitted).
const NO_STORE_PRODUCT: u32 = 0x803F_6107;

pub(super) fn check() -> Result<Option<String>, StoreUpdateError> {
    let context = StoreContext::GetDefault()?;
    let product = context.GetStoreProductForCurrentAppAsync()?.join()?;
    let hresult = product.ExtendedError()?;
    if hresult.is_err() || product.Product().is_err() {
        let code = hresult.0.cast_unsigned();
        return Err(if code == NO_STORE_PRODUCT {
            StoreUpdateError::NotFromStore
        } else {
            StoreUpdateError::Failed(format!("store product lookup failed: {code:#010x}"))
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
            let app_version = super::app_version(version.Major, version.Minor, version.Build)
                .ok_or_else(|| {
                    StoreUpdateError::Failed(format!(
                        "Store package version {}.{}.{}.{} does not follow the App version rule",
                        version.Major, version.Minor, version.Build, version.Revision
                    ))
                })?;
            return Ok(Some(app_version));
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
        return Err(StoreUpdateError::NotSilent);
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
    if !context.CanSilentlyDownloadStorePackageUpdates()? {
        return Err(StoreUpdateError::NotSilent);
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

pub(super) fn open_updates_page() -> Result<(), StoreUpdateError> {
    let opened =
        ::windows::System::Launcher::LaunchUriAsync(&::windows::Foundation::Uri::CreateUri(
            &::windows::core::HSTRING::from("ms-windows-store://downloadsandupdates"),
        )?)?
        .join()?;
    if !opened {
        return Err(StoreUpdateError::Failed(
            "the Microsoft Store could not be opened".into(),
        ));
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
