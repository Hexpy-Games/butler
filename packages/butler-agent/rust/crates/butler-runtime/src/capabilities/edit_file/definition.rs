use serde_json::{Value, json};

pub(in crate::capabilities) fn definition() -> Value {
    json!({
        "type":"function","name":"edit_file",
        "description":"Make one small, exact change in a UTF-8 workspace file or an ordered 2-20 edit batch. Repeated paths are allowed: each edit addresses the preceding in-memory result, and each file is committed once. start_line is an optional location hint. Batches require each file's initial expected_sha256, preflight all entries, and report partial state on external change. Use write_file for complete content and Project Ledger tools for Ledger files.",
        "parameters":{
            "type":"object","additionalProperties":false,
            "properties":{
                "path":{"type":"string","description":"File path inside the active workspace. Prefer a workspace-relative path; a contained absolute path shown by a tool is also accepted."},
                "start_line":{"type":"integer","minimum":1,"description":"Optional one-based location hint for old_text. It may be stale after earlier edits; the exact text remains authoritative."},
                "old_text":{"type":"string","minLength":1,"description":"Exact existing text copied from the current file. Include indentation and line breaks exactly as they appear."},
                "new_text":{"type":"string","description":"Exact replacement text. An empty string removes old_text."},
                "expected_sha256":{"type":"string","pattern":"^[a-fA-F0-9]{64}$","description":"Optional SHA-256 of the complete current file for a single edit (64 hexadecimal characters; case-insensitive). The edit is rejected when it does not match."},
                "edits":{"type":"array","minItems":2,"maxItems":20,
                    "description":"Ordered exact edits, including repeated paths. Later edits address preceding results. Runtime guards each file's initial state and commits it once.",
                    "items":{"type":"object","additionalProperties":false,
                        "properties":{
                            "path":{"type":"string","minLength":1},
                            "start_line":{"type":"integer","minimum":1},
                            "old_text":{"type":"string","minLength":1},
                            "new_text":{"type":"string"},
                            "expected_sha256":{"type":"string","pattern":"^[a-fA-F0-9]{64}$"}
                        },
                        "required":["path","old_text","new_text","expected_sha256"]
                    }
                }
            },
            "oneOf":[
                {"required":["path","old_text","new_text"],"not":{"required":["edits"]}},
                {"required":["edits"],"not":{"anyOf":[{"required":["path"]},
                    {"required":["start_line"]},{"required":["old_text"]},
                    {"required":["new_text"]},{"required":["expected_sha256"]}]}}
            ]
        },
        "effectBoundary":"reviewed_persistent","concurrencySafe":false,
        "interruptBehavior":"continue","transcriptVisibility":"visible"
    })
}
