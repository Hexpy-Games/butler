use std::{fs, path::PathBuf};

use serde_json::{Map, Value, json};

use super::{TempImageFile, admitted_image, frozen_carrier_valid, project_result, required_text};
use crate::{context::ImageCarrierTuple, public_text::trim_js_whitespace};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("butler-zai-image-{}", uuid::Uuid::new_v4())))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn temp_derivative_is_private_and_removed_on_drop() {
    let scratch = Scratch::new();
    fs::create_dir_all(&scratch.0).unwrap();
    let path;
    {
        let temp = TempImageFile::create(&scratch.0, ".png", b"verified bytes").unwrap();
        path = temp.file_path().to_path_buf();
        assert_eq!(fs::read(&path).unwrap(), b"verified bytes");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(temp.directory()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
    assert!(!path.exists());
    assert_eq!(fs::read_dir(&scratch.0).unwrap().count(), 0);
}

#[test]
fn frozen_route_requires_exact_zai_tool_digest_and_prompt_trim() {
    let tuple: ImageCarrierTuple = serde_json::from_value(json!({
        "providerId":"zai", "modelId":"glm-5.2", "carrierProtocol":"zai_mcp_vision",
        "endpointProfileId":"profile", "catalogCapabilityRevision":"revision",
        "catalogCapabilityDigest":"digest"
    }))
    .unwrap();
    let context = valid_context();
    let (_, capability, _, _) = admitted_image(&context, "file-current").unwrap();
    assert!(frozen_carrier_valid(&tuple, &capability));
    assert!(!frozen_carrier_valid(
        &tuple,
        &crate::context::ImageCapabilityEvidence {
            tool_capability_digest: Some("changed".into()),
            ..capability
        }
    ));
    let args = Map::from_iter([("prompt".into(), Value::String("  hi  ".into()))]);
    assert_eq!(
        required_text(&args, "prompt", "prompt_required", "missing").unwrap(),
        trim_js_whitespace("  hi  ")
    );
}

#[test]
fn image_authorization_requires_current_attached_file_id() {
    let context = valid_context();
    assert!(admitted_image(&context, "file-current").is_ok());
    assert!(admitted_image(&context, "file-other").is_err());
    assert!(admitted_image(&json!({"attachments":[]}), "file-current").is_err());
}

#[test]
fn result_projection_scrubs_temp_paths_and_keeps_source_fields() {
    let temp_root = PathBuf::from("/private/data/.butler-zai-vision-test");
    let temp_path = temp_root.join("input.png");
    let output = project_result(
        json!({"ok":true,"result":{"content":[{"type":"text","text":format!("path {0}",temp_path.display())}]}}),
        "file-current",
        &temp_root,
        temp_path,
    );
    assert_eq!(output["analysis"], "path [redacted-image-source]");
    assert_eq!(output["server_id"], "zai-vision");
    assert_eq!(output["tool_name"], "analyze_image");
}

fn valid_context() -> Value {
    json!({
        "attachments":[{"id":"file-current","kind":"image"}],
        "imageAdmission":{
            "tuple":{"providerId":"zai","modelId":"glm-5.2","carrierProtocol":"zai_mcp_vision","endpointProfileId":"profile","catalogCapabilityRevision":"revision","catalogCapabilityDigest":"digest"},
            "capability":{"providerId":"zai","modelId":"glm-5.2","carrierProtocol":"zai_mcp_vision","endpointProfileId":"profile","catalogCapabilityRevision":"revision","catalogCapabilityDigest":"digest","modelSupport":"supported","capabilitySource":"provider_discovery","routeHealth":"healthy","inputModalities":["image"],"acceptedMimeTypes":["image/png"],"maxInlineImageBytes":1000,"maxWidth":100,"maxHeight":100,"maxPixels":10000,"sourceUrl":"https://example.test","verifiedAt":"now","evidenceRevision":"revision","evidenceDigest":"digest","toolServerId":"zai-vision","toolName":"analyze_image","toolCapabilityDigest":"digest"},
            "manifests":[{"kind":"image","fileId":"file-current","position":0,"safeName":"image.png","mimeType":"image/png","sniffedMimeType":"image/png","sniffedMagic":"png","storageRevision":"revision","sourceSizeBytes":10,"sourceDigest":"s","derivativeId":"d","derivativeMimeType":"image/png","derivativeSizeBytes":5,"derivativeDigest":"d","width":1,"height":1,"pixelCount":1,"sanitizerRevision":"r","manifestDigest":"m"}]
        }
    })
}
