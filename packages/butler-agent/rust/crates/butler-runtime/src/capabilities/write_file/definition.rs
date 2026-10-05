use serde_json::{Value, json};

pub(in crate::capabilities) fn definition() -> Value {
    json!({
        "type":"function", "name":"write_file",
        "description":"Atomically create a UTF-8 workspace file or replace its complete desired content. content is never a patch, fragment, or append; use edit_file for exact changes. Creation requires overwrite=false. Replacement requires overwrite=true and current expected_sha256; a target appearing after preflight is not overwritten. Ask-first requires approval of the exact file operation; full access runs directly.",
        "parameters":{
            "type":"object","additionalProperties":false,
            "properties":{
                "path":{"type":"string","description":"Absolute file path or a path resolved against the session workspace."},
                "content":{"type":"string"},"overwrite":{"type":"boolean"},
                "expected_sha256":{"type":"string","pattern":"^[a-fA-F0-9]{64}$",
                    "description":"Required replacement SHA-256 (64 hexadecimal characters; case-insensitive)."},
                "create_parents":{"type":"boolean"}
            },
            "required":["path","content","overwrite"]
        },
        "effectBoundary":"reviewed_persistent","concurrencySafe":false,
        "interruptBehavior":"continue","transcriptVisibility":"visible"
    })
}
