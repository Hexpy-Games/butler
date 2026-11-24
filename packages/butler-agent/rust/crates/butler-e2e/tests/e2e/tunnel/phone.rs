use axum::extract::ws::{Message, WebSocket};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::{Buf, BufMut, Bytes, BytesMut};
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit,
    aead::{Aead, Payload},
};
use serde::Deserialize;
use serde_json::{Value, json};
use snow::{
    Builder, HandshakeState,
    params::DHChoice,
    resolvers::{CryptoResolver, DefaultResolver},
};
use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) struct Phone([u8; 32]);

#[derive(Deserialize)]
pub(super) struct Reply {
    pub(super) status: u16,
    #[allow(
        dead_code,
        reason = "Return the complete response head to the scenario"
    )]
    pub(super) headers: BTreeMap<String, String>,
    #[serde(skip)]
    pub(super) body: Vec<u8>,
}

#[derive(Debug)]
pub(super) struct Reset(
    #[allow(dead_code, reason = "A relay RESET returns its wire reason")] pub(super) u8,
);

impl Phone {
    pub(super) fn new() -> Self {
        let mut key = [0; 32];
        key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self(key)
    }

    pub(super) fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(public_key(&self.0))
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "One explicit set of wire request parameters"
    )]
    pub(super) async fn request(
        &self,
        socket: &mut WebSocket,
        stream_id: u32,
        desktop_public: &[u8; 32],
        tunnel_id: &str,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Reply, Reset> {
        let mut headers = BTreeMap::new();
        if let Some(token) = token {
            headers.insert("authorization", format!("Bearer {token}"));
        }
        if body.is_some() {
            headers.insert("content-type", "application/json".into());
        }
        let body_key = Self::new().0;
        let ts = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let head = serde_json::to_vec(&json!({
            "v": 1, "ts": ts, "rid": URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes()),
            "target": "api", "method": method, "path": path, "headers": headers,
            "body_key": URL_SAFE_NO_PAD.encode(body_key), "has_body": body.is_some(),
        }))
        .unwrap();
        let mut handshake = initiator(&self.0, desktop_public, None, tunnel_id);
        let mut message1 = vec![0; 65_535];
        let len = handshake.write_message(&head, &mut message1).unwrap();
        message1.truncate(len);
        let mut records = BytesMut::new();
        append_record(&mut records, &message1);
        if let Some(body) = body {
            append_record(
                &mut records,
                &encrypt_body(&body_key, &serde_json::to_vec(&body).unwrap()),
            );
        }
        socket.send(frame(1, stream_id, &[])).await.unwrap();
        for chunk in records.chunks(65_536) {
            socket.send(frame(2, stream_id, chunk)).await.unwrap();
        }
        socket.send(frame(3, stream_id, &[])).await.unwrap();

        let mut records = BytesMut::new();
        loop {
            match socket.recv().await.unwrap().unwrap() {
                Message::Binary(mut bytes) => {
                    let kind = bytes.get_u8();
                    assert_eq!(bytes.get_u32(), stream_id);
                    match kind {
                        2 => {
                            let credit = u32::try_from(bytes.len()).unwrap();
                            records.extend_from_slice(&bytes);
                            socket
                                .send(frame(5, stream_id, &credit.to_be_bytes()))
                                .await
                                .unwrap();
                        }
                        3 => break,
                        4 => return Err(Reset(bytes.get_u8())),
                        _ => panic!("unexpected frame type {kind}"),
                    }
                }
                Message::Text(text) if text.as_str() == "ping" => {
                    socket.send(Message::Text("pong".into())).await.unwrap();
                }
                _ => panic!("unexpected WebSocket message"),
            }
        }
        let mut plaintext = vec![0; 65_552];
        let first = next_record(&mut records);
        let len = handshake.read_message(&first, &mut plaintext).unwrap();
        let mut reply: Reply = serde_json::from_slice(&plaintext[..len]).unwrap();
        let mut transport = handshake.into_transport_mode().unwrap();
        loop {
            let ciphertext = next_record(&mut records);
            let len = transport.read_message(&ciphertext, &mut plaintext).unwrap();
            if len == 0 {
                assert!(records.is_empty());
                break;
            }
            reply.body.extend_from_slice(&plaintext[..len]);
        }
        Ok(reply)
    }
}

pub(super) fn public_key(private: &[u8; 32]) -> [u8; 32] {
    let mut dh = DefaultResolver.resolve_dh(&DHChoice::Curve25519).unwrap();
    dh.set(private);
    dh.pubkey().try_into().unwrap()
}

pub(super) fn initiator(
    private: &[u8; 32],
    remote: &[u8; 32],
    ephemeral: Option<&[u8; 32]>,
    tunnel_id: &str,
) -> HandshakeState {
    let prologue = format!("butler-tunnel/1 {tunnel_id}");
    let mut builder = Builder::new("Noise_IK_25519_ChaChaPoly_BLAKE2s".parse().unwrap())
        .local_private_key(private)
        .remote_public_key(remote)
        .prologue(prologue.as_bytes());
    if let Some(ephemeral) = ephemeral {
        builder = builder.fixed_ephemeral_key_for_testing_only(ephemeral);
    }
    builder.build_initiator().unwrap()
}

pub(super) fn encrypt_body(key: &[u8; 32], body: &[u8]) -> Vec<u8> {
    ChaCha20Poly1305::new(key.into())
        .encrypt(
            (&[0; 12]).into(),
            Payload {
                msg: body,
                aad: b"end",
            },
        )
        .unwrap()
}

pub(super) fn append_record(output: &mut BytesMut, ciphertext: &[u8]) {
    output.put_u32(u32::try_from(ciphertext.len()).unwrap());
    output.extend_from_slice(ciphertext);
}

fn next_record(input: &mut BytesMut) -> Bytes {
    let len = input.get_u32() as usize;
    input.split_to(len).freeze()
}

fn frame(kind: u8, id: u32, payload: &[u8]) -> Message {
    let mut bytes = BytesMut::with_capacity(5 + payload.len());
    bytes.put_u8(kind);
    bytes.put_u32(id);
    bytes.extend_from_slice(payload);
    Message::Binary(bytes.freeze())
}
