use crate::Error;

/// A file uploaded without changing its bytes or media type.
#[derive(Clone, Debug)]
pub struct Upload {
    /// File name sent in the multipart disposition.
    pub file_name: String,
    /// Media type of the file part.
    pub content_type: String,
    /// Complete file contents.
    pub bytes: Vec<u8>,
}

pub(crate) fn encode(
    fields: &[(&str, &str)],
    file_field: &str,
    file: &Upload,
) -> Result<(String, Vec<u8>), Error> {
    if fields
        .iter()
        .any(|(name, value)| invalid(name) || invalid(value))
        || invalid(file_field)
        || invalid(&file.file_name)
        || invalid(&file.content_type)
    {
        return Err(Error::Protocol);
    }
    let boundary = uuid::Uuid::new_v4().simple().to_string();
    let mut bytes = Vec::new();
    for (name, value) in fields {
        bytes.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{value}\r\n",
                quoted(name)
            )
            .as_bytes(),
        );
    }
    bytes.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n", quoted(file_field), quoted(&file.file_name), file.content_type).as_bytes());
    bytes.extend_from_slice(&file.bytes);
    bytes.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), bytes))
}
fn invalid(value: &str) -> bool {
    value.contains(['\r', '\n'])
}
fn quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "%22")
}
