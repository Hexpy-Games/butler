use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::models::ProviderPromptRequest;

fn request(attachment: &AttachmentRef) -> ProviderPromptRequest<'_> {
    ProviderPromptRequest {
        prompt: "Hello",
        model: None,
        reasoning_effort: None,
        instructions: None,
        response_format: None,
        cache_scope: None,
        cache_boundary: None,
        cancellation: CancellationToken::new(),
        attachments: std::slice::from_ref(attachment),
        butler_data: None,
        usage_attribution: None,
        stream_observer: None,
        provider_retry_attempts: None,
    }
}

#[test]
fn text_attachment_matches_bun_context_and_normalizes_crlf_nul() {
    let root = std::env::temp_dir().join(format!("butler-prompt-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("note.txt");
    std::fs::write(&path, b"line 1\r\nline 2\0").unwrap();
    let attachment = AttachmentRef {
        id: "local-note".into(),
        kind: AttachmentKind::Document,
        mime_type: Some("text/plain".into()),
        file_name: Some(" note.txt ".into()),
        size_bytes: Some(14.0),
        url: None,
        local_path: Some(path.to_string_lossy().into_owned()),
        visual_manifest: None,
    };
    assert_eq!(
        prompt(&request(&attachment)).unwrap(),
        "Hello\n\n## Attachments\n- note.txt (document, text/plain, 14 bytes, id: local-note)\n\n### Attachment Content: note.txt\nAttachment ID: local-note\n````text\nline 1\nline 2\n````"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn image_attachment_requires_the_admitted_payload_boundary() {
    let attachment = AttachmentRef {
        id: "image".into(),
        kind: AttachmentKind::Image,
        mime_type: Some("image/png".into()),
        file_name: None,
        size_bytes: None,
        url: None,
        local_path: None,
        visual_manifest: Some(Value::Null),
    };
    assert!(matches!(
        prompt(&request(&attachment)),
        Err(ModelRoundError::InvocationFailure { code: Some(code), .. })
            if code == "verified_image_payload_port_required"
    ));
}
