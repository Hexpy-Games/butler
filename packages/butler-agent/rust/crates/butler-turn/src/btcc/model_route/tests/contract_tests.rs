use serde_json::json;

use super::super::support::rebase_continuation;
use crate::btcc::agent_loop::ModelRoundError;

#[test]
fn continuation_rebase_validates_only_accepted_identity_and_compares_json_bytes() {
    let current = json!({"projectionRevision":"butler.rolling-context.v1","schemaVersion":"butler.context-projection-rebase.v1","projectionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","projectedThroughOrdinal":1});
    let bounded = json!({"contextProjection": current});
    let accepted_same_fields_different_order = json!({"contextProjection":{"schemaVersion":"butler.context-projection-rebase.v1","projectionRevision":"butler.rolling-context.v1","projectionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","projectedThroughOrdinal":1}});
    assert_eq!(
        rebase_continuation(Some(&bounded), Some(&accepted_same_fields_different_order)).unwrap(),
        None
    );

    let opaque_current = json!({"unvalidatedCurrent":true});
    let opaque_bounded = json!({"contextProjection": opaque_current});
    assert_eq!(
        rebase_continuation(Some(&opaque_bounded), None).unwrap(),
        None
    );
    let invalid_accepted = json!({"contextProjection":{"unvalidatedAccepted":true}});
    assert!(matches!(
        rebase_continuation(Some(&bounded), Some(&invalid_accepted)),
        Err(ModelRoundError::Integrity(ref value))
            if value.code() == "phase_continuity_projection_rebase_identity_invalid"
    ));
}
