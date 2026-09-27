use serde_json::{Map, Value, json};

use super::super::{invalid, required_string};
use crate::project_ledger::ProjectLedgerReadError;

pub(super) fn matches(
    manifest: &Value,
    plan: Option<&Value>,
    checkpoint: Option<&Value>,
    reviews: &[Option<Value>; 3],
) -> Result<(), ProjectLedgerReadError> {
    let snapshot = manifest
        .get("materialSnapshot")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let expected_keys = [
        "materialFingerprint",
        "workId",
        "status",
        "currentPlan",
        "actionProgress",
        "latestCheckpoint",
        "reviews",
        "resultRefs",
        "effectWatermark",
        "effectBlockers",
    ];
    if snapshot.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !snapshot.contains_key(*key))
    {
        return Err(invalid());
    }
    let current_plan = plan
        .map(|child| {
            let plan = child.get("plan").ok_or_else(invalid)?;
            let mut object = plan.as_object().ok_or_else(invalid)?.clone();
            if !object.contains_key("governingRefs") {
                object.insert("governingRefs".into(), json!([]));
            }
            Ok::<_, ProjectLedgerReadError>(Value::Object(object))
        })
        .transpose()?
        .unwrap_or(Value::Null);
    let checkpoint_view = checkpoint
        .map(|child| {
            let item = child.get("checkpoint").ok_or_else(invalid)?;
            let refs = item
                .get("referencedResultRefs")
                .and_then(Value::as_array)
                .ok_or_else(invalid)?;
            Ok::<_, ProjectLedgerReadError>(json!({
                "revision":item.get("revision"),
                "planRevisionId":item.get("planRevisionId"),
                "stage":item.get("stage"),
                "actionProgress":progress(item.get("actionProgress").ok_or_else(invalid)?)?,
                "resultSequence":refs.len(),
                "referencedResultRefs":refs,
            }))
        })
        .transpose()?
        .unwrap_or(Value::Null);
    let review_views = reviews.iter().map(|child| child.as_ref().map(|child| {
        let item = child.get("review").ok_or_else(invalid)?;
        Ok::<_, ProjectLedgerReadError>(json!({
            "reviewRevisionId":item.get("reviewRevisionId"),
            "revision":item.get("revision"),
            "verdict":item.get("verdict"),
            "boundPlanRevisionId":item.get("boundPlanRevisionId").unwrap_or(&Value::Null),
            "boundResultReviewRevisionId":item.get("boundResultReviewRevisionId").unwrap_or(&Value::Null),
            "boundActionProgress":item.get("boundActionProgress").map(progress).transpose()?.unwrap_or(Value::Null),
            "boundResultRefs":item.get("boundResultRefs"),
        }))
    }).transpose().map(|value| value.unwrap_or(Value::Null)))
        .collect::<Result<Vec<_>, _>>()?;
    let refs = manifest
        .get("resultRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let refs = refs
        .iter()
        .map(|item| {
            json!({
                "resultRef":item.get("resultRef"), "toolCallId":item.get("toolCallId"),
                "status":item.get("status"), "originTurnId":item.get("originTurnId"),
            })
        })
        .collect::<Vec<_>>();
    let blockers = snapshot
        .get("effectBlockers")
        .and_then(Value::as_array)
        .filter(|items| items.len() <= 512)
        .ok_or_else(invalid)?;
    for blocker in blockers {
        let object = blocker.as_object().ok_or_else(invalid)?;
        if object.len() != 5
            || [
                "blockerId",
                "sourceTurnId",
                "capabilitySha256",
                "targetSha256",
                "detailSha256",
            ]
            .iter()
            .any(|key| !object.contains_key(*key))
        {
            return Err(invalid());
        }
        for key in [
            "blockerId",
            "sourceTurnId",
            "capabilitySha256",
            "targetSha256",
            "detailSha256",
        ] {
            required_string(blocker, key)?;
        }
    }
    let expected = json!({
        "materialFingerprint": manifest.get("materialFingerprint"),
        "workId":manifest.get("workId"),
        "status":manifest.get("status"),
        "currentPlan":current_plan,
        "actionProgress":progress(manifest.get("actionProgress").ok_or_else(invalid)?)?,
        "latestCheckpoint":checkpoint_view,
        "reviews":review_views,
        "resultRefs":refs,
        "effectWatermark":snapshot.get("effectWatermark"),
        "effectBlockers":blockers,
    });
    if Value::Object(snapshot.clone()) != expected {
        return Err(invalid());
    }
    Ok(())
}

fn progress(value: &Value) -> Result<Value, ProjectLedgerReadError> {
    let items = value
        .as_array()
        .filter(|items| items.len() <= 512)
        .ok_or_else(invalid)?;
    let mut projected = Vec::with_capacity(items.len());
    for item in items {
        let object = item.as_object().ok_or_else(invalid)?;
        if !object.contains_key("actionKey") || !object.contains_key("status") || object.len() > 3 {
            return Err(invalid());
        }
        let mut value = Map::new();
        value.insert(
            "actionKey".into(),
            item.get("actionKey").cloned().ok_or_else(invalid)?,
        );
        value.insert(
            "status".into(),
            item.get("status").cloned().ok_or_else(invalid)?,
        );
        value.insert(
            "note".into(),
            item.get("note").cloned().unwrap_or(Value::Null),
        );
        projected.push(Value::Object(value));
    }
    Ok(Value::Array(projected))
}
