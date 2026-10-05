//! Test media: a PNG that renders digits (for image scenarios) and the
//! multipart upload the App uses for `POST /message-files`.

use sha2::{Digest, Sha256};

use super::HarnessError;
use super::gateway::{Gateway, Reply};

/// 5x7 bitmap glyphs for `0`-`9`, one row per byte (low 5 bits).
const DIGITS: [[u8; 7]; 10] = [
    [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
    [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
    [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
    [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
    [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
    [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
    [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
    [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
    [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
];

/// Black digits on white, `scale` pixels per glyph dot, 8-bit RGB PNG.
pub fn digits_png(text: &str, scale: usize) -> Vec<u8> {
    let digits: Vec<usize> = text
        .chars()
        .filter_map(|c| c.to_digit(10).map(|d| d as usize))
        .collect();
    let margin = 2 * scale;
    let width = margin * 2 + digits.len() * 6 * scale;
    let height = margin * 2 + 7 * scale;
    let mut raw = Vec::with_capacity((width * 3 + 1) * height);
    for y in 0..height {
        raw.push(0); // filter: none
        for x in 0..width {
            let mut ink = false;
            if y >= margin && x >= margin {
                let (gy, gx) = ((y - margin) / scale, (x - margin) / scale);
                let (index, column) = (gx / 6, gx % 6);
                if gy < 7 && column < 5 && index < digits.len() {
                    ink = DIGITS[digits[index]][gy] & (0x10 >> column) != 0;
                }
            }
            let value = if ink { 0 } else { 255 };
            raw.extend_from_slice(&[value, value, value]);
        }
    }
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::new();
    header.extend_from_slice(&u32::try_from(width).unwrap_or(0).to_be_bytes());
    header.extend_from_slice(&u32::try_from(height).unwrap_or(0).to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut png, *b"IHDR", &header);
    chunk(&mut png, *b"IDAT", &zlib_stored(&raw));
    chunk(&mut png, *b"IEND", &[]);
    png
}

/// A PNG whose header claims `width` x `height` pixels over a tiny, unrelated
/// body: an image that is only harmful once decoded.
pub fn png_claiming(width: u32, height: u32) -> Vec<u8> {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut png, *b"IHDR", &header);
    chunk(&mut png, *b"IDAT", &zlib_stored(&[0; 16]));
    chunk(&mut png, *b"IEND", &[]);
    png
}

fn chunk(out: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(0).to_be_bytes());
    let mut crc_input = kind.to_vec();
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc_input);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = data.chunks(65_535).collect();
    for (index, block) in blocks.iter().enumerate() {
        out.push(u8::from(index + 1 == blocks.len()));
        let len = u16::try_from(block.len()).unwrap_or(u16::MAX);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    out.extend_from_slice(&((b << 16) | a).to_be_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// `(content-type, body)` of a multipart upload: `file`, optional `session_id`.
pub fn multipart_file(
    name: &str,
    mime: &str,
    bytes: &[u8],
    session_id: Option<&str>,
) -> (String, Vec<u8>) {
    let boundary = format!("e2e{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::new();
    if let Some(session) = session_id {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"session_id\"\r\n\r\n{session}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

impl Gateway {
    /// `POST /message-files` as multipart (`file`, optional `session_id`).
    pub async fn upload(
        &self,
        name: &str,
        mime: &str,
        bytes: &[u8],
        session_id: Option<&str>,
    ) -> Result<Reply, HarnessError> {
        let (content_type, body) = multipart_file(name, mime, bytes, session_id);
        self.post_multipart("/message-files", content_type, body)
            .await
    }

    /// `POST <path>` with one multipart `file` field (wallpaper uploads,
    /// module archives).
    pub async fn upload_file(
        &self,
        path: &str,
        name: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<Reply, HarnessError> {
        let (content_type, body) = multipart_file(name, mime, bytes, None);
        self.post_multipart(path, content_type, body).await
    }

    async fn post_multipart(
        &self,
        path: &str,
        content_type: String,
        body: Vec<u8>,
    ) -> Result<Reply, HarnessError> {
        let response = reqwest::Client::new()
            .post(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .header("content-type", content_type)
            .body(body)
            .send()
            .await?;
        let status = response.status().as_u16();
        let text = response.text().await?;
        let body = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        Ok(Reply {
            status,
            body,
            text,
            phases: None,
            dispatch_timing: None,
        })
    }

    /// Raw bytes of `GET <path>`.
    pub async fn download(&self, path: &str) -> Result<(u16, Vec<u8>), HarnessError> {
        let response = reqwest::Client::new()
            .get(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let status = response.status().as_u16();
        Ok((status, response.bytes().await?.to_vec()))
    }
}
