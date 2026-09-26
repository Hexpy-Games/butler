//! File bytes for App message uploads; AppApplication retains row and owner authority.

use std::{
    fs,
    path::{Path, PathBuf},
};

use bytes::Bytes;
use sha2::{Digest, Sha256};

use super::names;
use crate::{
    context::{PdfTextError, extract_pdf_text, pdf_sidecar_text},
    gateway::{
        AppFileWrite, AppIdentityClock, AppMessageFileSnapshot, GatewayApplicationError,
        MaterializedResponderFile,
    },
    public_text::trim_js_whitespace,
};

const MAX_BYTES: usize = 10 * 1024 * 1024;

pub(super) fn write(
    root: &Path,
    clock: &dyn AppIdentityClock,
    input: AppFileWrite,
) -> Result<MaterializedResponderFile, GatewayApplicationError> {
    let AppFileWrite {
        name,
        mime_type,
        bytes,
    } = input;
    if bytes.is_empty() {
        return Err(public(
            400,
            "message_file_empty",
            "Attachment file is empty.",
        ));
    }
    if bytes.len() > MAX_BYTES {
        return Err(public(
            413,
            "message_file_too_large",
            "Attachment file is too large.",
        ));
    }
    let safe_name = names::safe_name(&name).stored;
    let mime_type = names::normalized_mime(mime_type.as_deref().unwrap_or(""), &safe_name);
    let kind = names::kind(&mime_type, &safe_name);
    if kind == "generic"
        && mime_type != "application/pdf"
        && !safe_name.to_lowercase().ends_with(".pdf")
    {
        return Err(public(
            415,
            "message_file_unsupported_type",
            "Attachment file type is not supported.",
        ));
    }
    let id = format!("file-{}", clock.new_uuid());
    if !valid_id(&id) {
        return Err(GatewayApplicationError::Internal);
    }
    let file = MaterializedResponderFile {
        id: id.clone(),
        kind: kind.into(),
        mime_type,
        safe_name,
        size_bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        storage_name: id.clone(),
        created_at: clock.now_iso(),
    };
    fs::create_dir_all(root).map_err(internal)?;
    fs::write(root.join(id), &bytes).map_err(internal)?;
    drop(bytes);
    Ok(file)
}

pub(super) fn prepare(
    root: &Path,
    file: &AppMessageFileSnapshot,
) -> Result<(), GatewayApplicationError> {
    if !is_pdf(file) {
        return Ok(());
    }
    let path = file_path(root, file)?;
    let text = {
        let extraction = match fs::read(&path) {
            Ok(bytes) => extract_pdf_text(&bytes),
            Err(_) => Err(PdfTextError::Extraction),
        };
        pdf_sidecar_text(extraction)
    };
    let mut sidecar = path.as_os_str().to_os_string();
    sidecar.push(".txt");
    fs::write(PathBuf::from(sidecar), text.as_bytes()).map_err(internal)
}

pub(super) fn read(
    root: &Path,
    file: &AppMessageFileSnapshot,
) -> Result<Bytes, GatewayApplicationError> {
    let path = file_path(root, file)?;
    fs::read(path).map(Bytes::from).map_err(internal)
}

fn file_path(
    root: &Path,
    file: &AppMessageFileSnapshot,
) -> Result<PathBuf, GatewayApplicationError> {
    if file.storage_name != file.id || !valid_id(&file.id) {
        return Err(public(
            404,
            "message_file_not_found",
            "Attachment file not found.",
        ));
    }
    Ok(root.join(&file.id))
}

fn valid_id(id: &str) -> bool {
    id.get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file-"))
        && id.len() == 41
        && id[5..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn is_pdf(file: &AppMessageFileSnapshot) -> bool {
    trim_js_whitespace(file.mime_type.split(';').next().unwrap_or(""))
        .eq_ignore_ascii_case("application/pdf")
        || file.safe_name.to_lowercase().ends_with(".pdf")
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
    }
}

fn internal(_: std::io::Error) -> GatewayApplicationError {
    GatewayApplicationError::Internal
}
