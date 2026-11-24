use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use butler_e2e::e2e::HarnessError;
use butler_gateway::gateway::FixtureResponder;
use bytes::BytesMut;
use serde_json::{Value, json};

use super::phone::{append_record, encrypt_body, initiator, public_key};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../butler-protocol/fixtures/tunnel-e2e-vectors.json"
);
const TUNNEL: &str = "tun_0123456789ABCDEFGHJKMNPQRS";
const TS: u64 = 1_800_000_000_000;
const RID: [u8; 16] = [0xa1; 16];
const PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

#[test]
#[ignore = "generates the shared wire fixture once"]
fn tunnel_vectors_generate() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let sequence =
        |first: u8| std::array::from_fn::<_, 32, _>(|i| first + u8::try_from(i).unwrap());
    let desktop_static = sequence(0x01);
    let phone_static = sequence(0x21);
    let phone_ephemeral = sequence(0x41);
    let desktop_ephemeral = sequence(0x61);
    let body_key = sequence(0x81);
    let desktop_public = public_key(&desktop_static);
    let phone_public = public_key(&phone_static);
    let prologue = format!("butler-tunnel/1 {TUNNEL}");
    let mut phone = initiator(
        &phone_static,
        &desktop_public,
        Some(&phone_ephemeral),
        TUNNEL,
    );
    let mut desktop = snow::Builder::new(PATTERN.parse().unwrap())
        .local_private_key(&desktop_static)
        .fixed_ephemeral_key_for_testing_only(&desktop_ephemeral)
        .prologue(prologue.as_bytes())
        .build_responder()
        .unwrap();
    let head = serde_json::to_vec(&json!({
        "v": 1, "ts": TS, "rid": URL_SAFE_NO_PAD.encode(RID), "target": "api",
        "method": "POST", "path": "/devices/pair", "headers": {"content-type": "application/json"},
        "body_key": URL_SAFE_NO_PAD.encode(body_key), "has_body": true,
    }))
    .unwrap();
    let reply = br#"{"status":200,"headers":{"content-type":"text/plain"}}"#;
    let mut message1 = vec![0; 65_535];
    let len = phone.write_message(&head, &mut message1).unwrap();
    message1.truncate(len);
    let mut clear = vec![0; 65_535];
    let len = desktop.read_message(&message1, &mut clear).unwrap();
    assert_eq!(&clear[..len], head);
    let mut message2 = vec![0; 65_535];
    let len = desktop.write_message(reply, &mut message2).unwrap();
    message2.truncate(len);
    let len = phone.read_message(&message2, &mut clear).unwrap();
    assert_eq!(&clear[..len], reply);
    let mut transport = desktop.into_transport_mode().unwrap();
    let mut phone_transport = phone.into_transport_mode().unwrap();
    let transport: Vec<_> = [b"hello".as_slice(), b""]
        .into_iter()
        .map(|plaintext| {
            let mut ciphertext = vec![0; plaintext.len() + 16];
            transport.write_message(plaintext, &mut ciphertext).unwrap();
            let len = phone_transport
                .read_message(&ciphertext, &mut clear)
                .unwrap();
            assert_eq!(&clear[..len], plaintext);
            json!({"plaintext": hex(plaintext), "ciphertext": hex(&ciphertext)})
        })
        .collect();
    let body = b"body";
    let chunk = encrypt_body(&body_key, body);
    let mut records = BytesMut::new();
    append_record(&mut records, &message1);
    append_record(&mut records, &chunk);
    let fixture = json!({
        "v": 1, "protocol": PATTERN, "prologue": hex(prologue.as_bytes()),
        "desktop_static_private": hex(&desktop_static), "desktop_static_public": hex(&desktop_public),
        "phone_static_private": hex(&phone_static), "phone_static_public": hex(&phone_public),
        "phone_ephemeral_private": hex(&phone_ephemeral), "desktop_ephemeral_private": hex(&desktop_ephemeral),
        "message1": {"payload": hex(&head), "ciphertext": hex(&message1)},
        "message2": {"payload": hex(reply), "ciphertext": hex(&message2)},
        "transport": transport,
        "body_chunk": {"key": hex(&body_key), "counter": 0, "aad": "656e64", "plaintext": hex(body), "ciphertext": hex(&chunk)},
        "request_records": hex(&records),
    });
    std::fs::create_dir_all(std::path::Path::new(FIXTURE).parent().unwrap())?;
    std::fs::write(FIXTURE, serde_json::to_string_pretty(&fixture)? + "\n")?;
    Ok(())
}

#[test]
fn tunnel_vectors_01_responder_matches_fixture_and_rejects_replay() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture: Value = serde_json::from_slice(&std::fs::read(FIXTURE).unwrap()).unwrap();
    let private = unhex(&fixture["desktop_static_private"])
        .try_into()
        .unwrap();
    let ephemeral = unhex(&fixture["desktop_ephemeral_private"])
        .try_into()
        .unwrap();
    let records = unhex(&fixture["request_records"]);
    let head = unhex(&fixture["message1"]["payload"]);
    let payload = unhex(&fixture["message2"]["payload"]);
    let phone_private = unhex(&fixture["phone_static_private"]).try_into().unwrap();
    let phone_ephemeral = unhex(&fixture["phone_ephemeral_private"])
        .try_into()
        .unwrap();
    let desktop_public = unhex(&fixture["desktop_static_public"]).try_into().unwrap();
    let body_key = unhex(&fixture["body_chunk"]["key"]).try_into().unwrap();
    let mut phone = initiator(
        &phone_private,
        &desktop_public,
        Some(&phone_ephemeral),
        TUNNEL,
    );
    let mut message1 = vec![0; 65_535];
    let len = phone.write_message(&head, &mut message1).unwrap();
    message1.truncate(len);
    assert_eq!(message1, unhex(&fixture["message1"]["ciphertext"]));
    let chunk = encrypt_body(&body_key, b"body");
    assert_eq!(chunk, unhex(&fixture["body_chunk"]["ciphertext"]));
    let mut encoded = BytesMut::new();
    append_record(&mut encoded, &message1);
    append_record(&mut encoded, &chunk);
    assert_eq!(encoded.as_ref(), records);
    let ts = serde_json::from_slice::<Value>(&head).unwrap()["ts"]
        .as_u64()
        .unwrap();
    let transport = fixture["transport"].as_array().unwrap();
    let plaintexts: Vec<_> = transport
        .iter()
        .map(|row| unhex(&row["plaintext"]))
        .collect();
    let plaintexts: Vec<_> = plaintexts.iter().map(Vec::as_slice).collect();
    let responder = FixtureResponder::new(private, ephemeral, TUNNEL);
    let out = responder
        .respond(&records, ts, &payload, &plaintexts)
        .unwrap();
    assert_eq!(out.head_json, head);
    assert_eq!(out.body, b"body");
    assert_eq!(out.body, unhex(&fixture["body_chunk"]["plaintext"]));
    assert_eq!(
        out.remote_static.as_slice(),
        unhex(&fixture["phone_static_public"])
    );
    assert_eq!(out.message2, unhex(&fixture["message2"]["ciphertext"]));
    assert_eq!(
        out.transport,
        transport
            .iter()
            .map(|row| unhex(&row["ciphertext"]))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        responder.respond(&records, ts, &payload, &plaintexts).err(),
        Some("replay")
    );
    let fresh = FixtureResponder::new(private, ephemeral, TUNNEL);
    assert_eq!(
        fresh
            .respond(&records, ts + 300_001, &payload, &plaintexts)
            .err(),
        Some("stale")
    );
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(out, "{byte:02x}").unwrap();
    }
    out
}

fn unhex(value: &Value) -> Vec<u8> {
    value
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|digits| u8::from_str_radix(std::str::from_utf8(digits).unwrap(), 16).unwrap())
        .collect()
}
