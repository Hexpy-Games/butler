//! Password CSV exports (Chrome, Edge, Brave, Whale, Safari, Firefox). Every
//! cell is held in wiped-on-drop memory; nothing here logs or formats a value.
use super::ImportError;
use butler_platform::secrets::SecretText;
use zeroize::Zeroizing;

/// One web sign-in from an export. Its `Debug` output never shows the password.
#[derive(Debug)]
pub struct PasswordRow {
    /// The exact login origin (`https://host[:port]`).
    pub origin: String,
    /// Its registrable site.
    pub site: String,
    pub username: String,
    pub password: SecretText,
}

/// Rows with a web origin, a username and a password; others are counted as skipped.
pub fn parse_password_csv(bytes: &[u8]) -> Result<(Vec<PasswordRow>, usize), ImportError> {
    let text = std::str::from_utf8(bytes).map_err(|_| ImportError::Format)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut records = records(text).into_iter();
    let header = records.next().ok_or(ImportError::Format)?;
    let column = |names: &[&str]| {
        header
            .iter()
            .position(|cell| names.contains(&cell.trim().to_ascii_lowercase().as_str()))
    };
    let url = column(&["url", "origin", "website", "login_uri"]).ok_or(ImportError::Format)?;
    let user =
        column(&["username", "login", "login_username", "user name"]).ok_or(ImportError::Format)?;
    let pass = column(&["password", "login_password"]).ok_or(ImportError::Format)?;
    let mut rows = Vec::new();
    let mut skipped = 0;
    for record in records {
        let cell = |index: usize| record.get(index).map(|value| value.as_str()).unwrap_or("");
        match row(cell(url), cell(user), cell(pass)) {
            Some(row) => rows.push(row),
            None if record.iter().all(|value| value.is_empty()) => {}
            None => skipped += 1,
        }
    }
    Ok((rows, skipped))
}

fn row(url: &str, username: &str, password: &str) -> Option<PasswordRow> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    if !matches!(parsed.scheme(), "https" | "http") || username.is_empty() || password.is_empty() {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    let site = crate::browser::site_of(&origin)?;
    (site.contains('.') && username.len() <= 256 && password.len() <= 1024).then(|| PasswordRow {
        origin,
        site,
        username: username.trim().to_owned(),
        password: SecretText::new(password.to_owned()),
    })
}

/// Cells are pre-sized so typical values never reallocate (and leave copies).
fn fresh() -> Zeroizing<String> {
    Zeroizing::new(String::with_capacity(256))
}

/// RFC 4180 records: quoted cells, doubled quotes, CRLF or LF line ends.
fn records(text: &str) -> Vec<Vec<Zeroizing<String>>> {
    let mut records = Vec::new();
    let mut record: Vec<Zeroizing<String>> = Vec::new();
    let mut cell = fresh();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match (quoted, ch) {
            (true, '"') if chars.peek() == Some(&'"') => {
                chars.next();
                cell.push('"');
            }
            (true, '"') => quoted = false,
            (false, '"') if cell.is_empty() => quoted = true,
            (false, ',') => record.push(std::mem::replace(&mut cell, fresh())),
            (false, '\r') => {}
            (false, '\n') => {
                record.push(std::mem::replace(&mut cell, fresh()));
                records.push(std::mem::take(&mut record));
            }
            (_, _) => cell.push(ch),
        }
    }
    if !cell.is_empty() || !record.is_empty() {
        record.push(cell);
        records.push(record);
    }
    records
}
