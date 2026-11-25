//! Updates for an App installed from the Microsoft Store, through
//! `Windows.Services.Store.StoreContext`. Uses silent methods only: the window-owner
//! interop required by dialog methods is not reachable without unsafe code.
//! Every call blocks; run off async workers.

#[cfg(windows)]
mod windows;

/// A Store association, availability or update failure.
#[derive(Debug)]
pub enum StoreUpdateError {
    /// The package is not associated with a Store product (sideloaded, or not yet submitted).
    NotFromStore,
    /// The Store cannot install silently now (auto-update off or a metered network); the user finishes the update in the Store.
    NotSilent,
    /// The Store refused or failed; the text names the HRESULT or state.
    Failed(String),
}

/// The App version a Store package version was packed from (see
/// `packages/butler-app/scripts/windows/store/store-version.ts`): `(M+1).m.(p*1000+s)`, where
/// `s` is the preview number, or 999 for a stable release. The fourth part belongs to the Store.
pub fn app_version(major: u16, minor: u16, build: u16) -> Option<String> {
    let major = major.checked_sub(1)?;
    let (patch, slot) = (build / 1000, build % 1000);
    Some(if slot == 999 {
        format!("{major}.{minor}.{patch}")
    } else {
        format!("{major}.{minor}.{patch}-preview.{slot}")
    })
}

/// The newest App version the Store offers (see [app_version]), or None.
pub fn check() -> Result<Option<String>, StoreUpdateError> {
    #[cfg(windows)]
    {
        windows::check()
    }
    #[cfg(not(windows))]
    {
        Err(StoreUpdateError::Failed(
            "Microsoft Store updates exist only on Windows".into(),
        ))
    }
}

/// Downloads the available update without UI. Fails if none is available or
/// silent downloads are unavailable (Store auto-update off or a metered network).
pub fn download() -> Result<(), StoreUpdateError> {
    #[cfg(windows)]
    {
        windows::download()
    }
    #[cfg(not(windows))]
    {
        Err(StoreUpdateError::Failed(
            "Microsoft Store updates exist only on Windows".into(),
        ))
    }
}

/// Installs without UI. Windows closes the running package's processes to install.
pub fn install() -> Result<(), StoreUpdateError> {
    #[cfg(windows)]
    {
        windows::install()
    }
    #[cfg(not(windows))]
    {
        Err(StoreUpdateError::Failed(
            "Microsoft Store updates exist only on Windows".into(),
        ))
    }
}

/// Opens the Microsoft Store's downloads-and-updates page.
pub fn open_updates_page() -> Result<(), StoreUpdateError> {
    #[cfg(windows)]
    {
        windows::open_updates_page()
    }
    #[cfg(not(windows))]
    {
        Err(StoreUpdateError::Failed(
            "Microsoft Store updates exist only on Windows".into(),
        ))
    }
}

/// The App's AUMID (PackageFamilyName!AppId) from its first app list entry.
pub fn app_user_model_id() -> Result<String, StoreUpdateError> {
    #[cfg(windows)]
    {
        windows::app_user_model_id()
    }
    #[cfg(not(windows))]
    {
        Err(StoreUpdateError::Failed(
            "Microsoft Store updates exist only on Windows".into(),
        ))
    }
}
