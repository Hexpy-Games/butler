use std::{
    collections::{BTreeMap, HashMap},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Uri, header};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::{Buf, BufMut, Bytes, BytesMut};
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit,
    aead::{Aead, Payload},
};
use parking_lot::Mutex;
use serde::Deserialize;
use snow::{HandshakeState, TransportState};
use zeroize::Zeroizing;

use crate::gateway::crypto::random_bytes;

const PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
const MAX_HANDSHAKE: usize = 65_535;
const MAX_RECORD: usize = 65_552;
pub(super) const RESPONSE_CHUNK: usize = 61_440;

pub fn new_tunnel_key() -> Zeroizing<[u8; 32]> {
    Zeroizing::new(random_bytes())
}

pub(super) fn responder(
    key: &[u8; 32],
    tunnel_id: &str,
    ephemeral: Option<&[u8; 32]>,
) -> Result<HandshakeState, &'static str> {
    let params = PATTERN.parse().map_err(|_| "pattern")?;
    let prologue = format!("butler-tunnel/1 {tunnel_id}");
    let mut builder = snow::Builder::new(params)
        .local_private_key(key)
        .prologue(prologue.as_bytes());
    if let Some(ephemeral) = ephemeral {
        builder = builder.fixed_ephemeral_key_for_testing_only(ephemeral);
    }
    builder.build_responder().map_err(|_| "responder")
}

#[derive(Default)]
pub(super) struct RecordReader(BytesMut);

impl RecordReader {
    pub(super) fn push(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    pub(super) fn next(&mut self) -> Result<Option<Bytes>, &'static str> {
        let Some(mut prefix) = self.0.get(..4) else {
            return Ok(None);
        };
        let len = prefix.get_u32() as usize;
        if !(1..=MAX_RECORD).contains(&len) {
            return Err("record_length");
        }
        if self.0.len() < 4 + len {
            return Ok(None);
        }
        self.0.advance(4);
        Ok(Some(self.0.split_to(len).freeze()))
    }

    pub(super) fn finish(&self) -> Result<(), &'static str> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err("incomplete_record")
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Target {
    #[default]
    Api,
    Content,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestHead {
    v: u8,
    ts: u64,
    rid: String,
    #[serde(default)]
    target: Target,
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body_key: String,
    has_body: bool,
}

pub(super) struct Opened {
    pub(super) target: Target,
    pub(super) method: Method,
    pub(super) uri: Uri,
    pub(super) headers: HeaderMap,
    pub(super) body: Option<BodyChunks>,
    pub(super) remote_static: [u8; 32],
    pub(super) handshake: HandshakeState,
    #[cfg(feature = "test-support")]
    pub(super) head_json: Vec<u8>,
}

#[derive(Default)]
pub(super) struct ReplayGuard(Mutex<HashMap<[u8; 16], u64>>);

impl ReplayGuard {
    fn check(&self, ts: u64, rid: [u8; 16], now: u64) -> Result<(), &'static str> {
        if now.abs_diff(ts) > 300_000 {
            return Err("stale");
        }
        let mut seen = self.0.lock();
        seen.retain(|_, ts| now.saturating_sub(*ts) <= 600_000);
        if seen.contains_key(&rid) {
            return Err("replay");
        }
        seen.insert(rid, ts);
        Ok(())
    }
}

pub(super) fn now_ms() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
}

pub(super) fn open(
    mut handshake: HandshakeState,
    record: &[u8],
    replay: &ReplayGuard,
    now: u64,
) -> Result<Opened, &'static str> {
    let mut head_json = Zeroizing::new(vec![0; record.len()]);
    let len = handshake
        .read_message(record, &mut head_json)
        .map_err(|_| "message1")?;
    head_json.truncate(len);
    let head: RequestHead = serde_json::from_slice(&head_json).map_err(|_| "head")?;
    let uri: Uri = head.path.parse().map_err(|_| "path")?;
    if head.v != 1
        || !head.path.starts_with('/')
        || head.path.starts_with("//")
        || uri.scheme().is_some()
        || uri.authority().is_some()
        || head.path.contains('#')
    {
        return Err("head");
    }
    let method = Method::from_bytes(head.method.as_bytes()).map_err(|_| "method")?;
    let rid = URL_SAFE_NO_PAD
        .decode(head.rid)
        .map_err(|_| "rid")?
        .try_into()
        .map_err(|_| "rid")?;
    let encoded_key = Zeroizing::new(head.body_key);
    let key = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(encoded_key.as_bytes())
            .map_err(|_| "body_key")?,
    );
    let key: &[u8; 32] = key.as_slice().try_into().map_err(|_| "body_key")?;
    let mut headers = HeaderMap::new();
    for (name, value) in head.headers {
        if name.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err("header");
        }
        if !matches!(
            name.as_str(),
            "host"
                | "origin"
                | "content-length"
                | "transfer-encoding"
                | "connection"
                | "cookie"
                | "x-butler-admin"
        ) {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| "header")?,
                HeaderValue::from_str(&value).map_err(|_| "header")?,
            );
        }
    }
    replay.check(head.ts, rid, now)?;
    let remote_static = handshake
        .get_remote_static()
        .and_then(|key| key.try_into().ok())
        .ok_or("remote_static")?;
    Ok(Opened {
        target: head.target,
        method,
        uri,
        headers,
        body: head.has_body.then(|| BodyChunks {
            cipher: ChaCha20Poly1305::new(key.into()),
            counter: 0,
            done: false,
        }),
        remote_static,
        handshake,
        #[cfg(feature = "test-support")]
        head_json: head_json.to_vec(),
    })
}

pub(super) struct BodyChunks {
    cipher: ChaCha20Poly1305,
    counter: u64,
    done: bool,
}

impl BodyChunks {
    pub(super) fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Bytes, &'static str> {
        if self.done {
            return Err("extra_body");
        }
        let mut nonce = [0; 12];
        nonce[4..].copy_from_slice(&self.counter.to_be_bytes());
        let nonce = (&nonce).into();
        let plaintext = match self.cipher.decrypt(nonce, ciphertext) {
            Ok(chunk) => chunk,
            Err(_) => {
                let chunk = self
                    .cipher
                    .decrypt(
                        nonce,
                        Payload {
                            msg: ciphertext,
                            aad: b"end",
                        },
                    )
                    .map_err(|_| "body_chunk")?;
                self.done = true;
                chunk
            }
        };
        self.counter += 1;
        Ok(plaintext.into())
    }

    pub(super) fn finish(&self) -> Result<(), &'static str> {
        if self.done {
            Ok(())
        } else {
            Err("unfinished_body")
        }
    }
}

pub(super) fn response_head(status: u16, headers: &HeaderMap) -> Result<Vec<u8>, &'static str> {
    let mut values = BTreeMap::<&str, String>::new();
    for (name, value) in headers {
        if name != header::SET_COOKIE {
            let value = value.to_str().map_err(|_| "response_header")?;
            values
                .entry(name.as_str())
                .and_modify(|joined| {
                    joined.push_str(", ");
                    joined.push_str(value);
                })
                .or_insert_with(|| value.to_owned());
        }
    }
    serde_json::to_vec(&serde_json::json!({"status": status, "headers": values}))
        .map_err(|_| "response_head")
}

pub(super) fn response(
    mut handshake: HandshakeState,
    head: &[u8],
) -> Result<(Vec<u8>, TransportState), &'static str> {
    let mut ciphertext = vec![0; MAX_HANDSHAKE];
    let len = handshake
        .write_message(head, &mut ciphertext)
        .map_err(|_| "message2")?;
    ciphertext.truncate(len);
    let transport = handshake.into_transport_mode().map_err(|_| "transport")?;
    Ok((ciphertext, transport))
}

pub(super) fn transport_record(
    transport: &mut TransportState,
    plaintext: &[u8],
) -> Result<Vec<u8>, &'static str> {
    let mut ciphertext = vec![0; plaintext.len() + 16];
    let len = transport
        .write_message(plaintext, &mut ciphertext)
        .map_err(|_| "transport")?;
    ciphertext.truncate(len);
    Ok(ciphertext)
}

pub(super) fn frame_record(ciphertext: &[u8]) -> Bytes {
    let len = ciphertext.len();
    let mut record = BytesMut::with_capacity(4 + len);
    record.put_u32(u32::try_from(len).unwrap_or_default());
    record.extend_from_slice(ciphertext);
    record.freeze()
}
