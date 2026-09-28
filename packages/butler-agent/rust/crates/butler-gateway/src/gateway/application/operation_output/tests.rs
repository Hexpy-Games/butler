use base64::Engine;
use serde_json::json;

use super::chunk::sha256;
use super::{AppOutputRead, OUTPUT_PAGE_BYTES, OperationOutputChunk, StoredChunk, verify_rows};

#[test]
fn child_event_projection_requires_public_exact_well_formed_chunk() {
    let bytes = b"child output";
    let result_sha256 = sha256(bytes);
    let result_id = result_id_for(bytes);
    let event = json!({
        "kind":"operation.output.chunk",
        "visibility":"public",
        "payload":{
            "requestId":"request-child",
            "resultId":result_id,
            "resultSha256":result_sha256,
            "chunkIndex":0,
            "chunkCount":1,
            "byteStart":0,
            "byteEnd":bytes.len(),
            "byteLength":bytes.len(),
            "contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),
            "contentSha256":sha256(bytes),
            "privateExtra":"dropped",
        }
    });
    let chunk =
        OperationOutputChunk::from_public_event(&event, "request-child", &result_id).unwrap();
    assert_eq!(chunk.request_id, "request-child");
    assert_eq!(chunk.content_sha256, sha256(bytes));
    let verified = verify_rows(
        std::iter::once(Ok(StoredChunk::from(chunk))),
        &result_id,
        0,
        OUTPUT_PAGE_BYTES,
    )
    .unwrap();
    let AppOutputRead::Complete(page) = verified else {
        panic!("valid single-chunk result should be complete");
    };
    assert_eq!(page.content.as_slice(), bytes);
    assert_eq!(page.byte_length, bytes.len() as u64);

    let mut private = event.clone();
    private["visibility"] = "internal".into();
    assert!(
        OperationOutputChunk::from_public_event(&private, "request-child", &result_id).is_none()
    );
    assert!(OperationOutputChunk::from_public_event(&event, "other-request", &result_id).is_none());
    let mut malformed = event;
    malformed["payload"]["contentSha256"] = "b".repeat(64).into();
    assert!(
        OperationOutputChunk::from_public_event(&malformed, "request-child", &result_id).is_none()
    );
}

fn result_id_for(bytes: &[u8]) -> String {
    let result_sha256 = sha256(bytes);
    sha256(format!("btcc-guided-tool-result.v1\0{result_sha256}").as_bytes())
}
