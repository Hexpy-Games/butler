use serde_json::{Value, json};

pub(super) fn image_context() -> Value {
    let digest = "d".repeat(64);
    let source_digest = "s".repeat(64);
    let derivative_digest = "e".repeat(64);
    let manifest_digest = "f".repeat(64);
    json!({
        "attachments":[{"id":"file-current","kind":"image"}],
        "imageAdmission":{
            "tuple":{
                "providerId":"zai",
                "modelId":"glm-5.3",
                "carrierProtocol":"zai_mcp_vision",
                "endpointProfileId":"profile",
                "catalogCapabilityRevision":"revision",
                "catalogCapabilityDigest":digest
            },
            "capability":{
                "providerId":"zai",
                "modelId":"glm-5.3",
                "carrierProtocol":"zai_mcp_vision",
                "endpointProfileId":"profile",
                "catalogCapabilityRevision":"revision",
                "catalogCapabilityDigest":digest,
                "modelSupport":"supported",
                "capabilitySource":"provider_discovery",
                "routeHealth":"healthy",
                "inputModalities":["image"],
                "acceptedMimeTypes":["image/png"],
                "maxInlineImageBytes":1024,
                "maxWidth":100,
                "maxHeight":100,
                "maxPixels":10000,
                "sourceUrl":"https://example.test",
                "verifiedAt":"2026-09-24T00:00:00Z",
                "evidenceRevision":"revision",
                "evidenceDigest":digest,
                "toolServerId":"zai-vision",
                "toolName":"analyze_image",
                "toolCapabilityDigest":digest
            },
            "manifests":[{
                "kind":"image",
                "fileId":"file-current",
                "position":0,
                "safeName":"image.png",
                "mimeType":"image/png",
                "sniffedMimeType":"image/png",
                "sniffedMagic":"png",
                "storageRevision":"message-file-row-v1",
                "sourceSizeBytes":10,
                "sourceDigest":source_digest,
                "derivativeId":"file-current:visual:test",
                "derivativeMimeType":"image/png",
                "derivativeSizeBytes":5,
                "derivativeDigest":derivative_digest,
                "width":1,
                "height":1,
                "pixelCount":1,
                "sanitizerRevision":"test",
                "manifestDigest":manifest_digest
            }]
        }
    })
}
