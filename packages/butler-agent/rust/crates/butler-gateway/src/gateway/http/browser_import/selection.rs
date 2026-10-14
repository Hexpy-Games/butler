//! Read selected source data completely before any storage effect.
use super::{HttpError, export_file, import, native_error, sources};
use butler_platform::{browser_profiles::BrowserProfile, secrets::SecretText};
use serde_json::{Value, json};
use std::path::PathBuf;

pub(super) struct Items {
    pub(super) bookmarks: bool,
    pub(super) passwords: bool,
    pub(super) history: bool,
}
pub(super) struct SelectedData {
    pub(super) bookmarks: Vec<import::Bookmark>,
    pub(super) passwords: Vec<import::PasswordRow>,
    pub(super) history: Vec<Value>,
    pub(super) invalid: usize,
    pub(super) csv_required: usize,
}
pub(super) struct Selection {
    pub(super) profile: Option<BrowserProfile>,
    pub(super) keys: std::sync::Arc<dyn butler_platform::browser_transfer::SafeStorageKeySource>,
    pub(super) items: Items,
    pub(super) csv: bool,
    pub(super) request: Value,
    pub(super) primary: SecretText,
    pub(super) scratch: PathBuf,
}
impl Drop for Selection {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.scratch);
    }
}
impl Selection {
    pub(super) fn read(&self) -> Result<SelectedData, HttpError> {
        let (passwords, invalid, csv_required) = self.read_passwords()?;
        Ok(SelectedData {
            bookmarks: self.read_bookmarks()?,
            passwords,
            invalid,
            csv_required,
            history: self.read_history()?,
        })
    }
    fn read_history(&self) -> Result<Vec<Value>, HttpError> {
        if !self.items.history {
            return Ok(Vec::new());
        }
        match &self.profile {
            Some(profile) => {
                import::history(profile, &self.scratch.join("history")).map_err(native_error)
            }
            None => Ok(Vec::new()),
        }
    }
    fn read_bookmarks(&self) -> Result<Vec<import::Bookmark>, HttpError> {
        if !self.items.bookmarks {
            return Ok(Vec::new());
        }
        if let Some(profile) = &self.profile {
            return sources::bookmarks(profile, &self.scratch.join("bookmarks"));
        }
        let file = export_file(
            &json!({"path":self.request["bookmarks_path"]}),
            import::MAX_BOOKMARK_BYTES,
        )?;
        let bytes = butler_platform::browser_transfer::read(&file, import::MAX_BOOKMARK_BYTES)
            .map_err(native_error)?;
        import::netscape_html(&String::from_utf8_lossy(&bytes))
            .and_then(import::finish)
            .map_err(|e| super::import_error(&e))
    }
    fn read_passwords(&self) -> Result<(Vec<import::PasswordRow>, usize, usize), HttpError> {
        if !self.items.passwords || self.csv {
            return Ok((Vec::new(), 0, 0));
        }
        if let Some(profile) = &self.profile {
            return butler_platform::browser_transfer::passwords(
                profile,
                &self.primary,
                &self.scratch.join("passwords"),
                self.keys.as_ref(),
            )
            .map(|batch| {
                let count = batch.logins.len();
                let rows = import::native_passwords(batch.logins);
                let invalid = batch.invalid + count - rows.len();
                (rows, invalid, batch.csv_required)
            })
            .map_err(native_error);
        }
        let file = export_file(
            &json!({"path":self.request["passwords_path"]}),
            import::MAX_CSV_BYTES,
        )?;
        let bytes = butler_platform::browser_transfer::read(&file, import::MAX_CSV_BYTES)
            .map_err(native_error)?;
        import::parse_password_csv(&bytes)
            .map(|(rows, invalid)| (rows, invalid, 0))
            .map_err(|e| super::import_error(&e))
    }
}
