//! Optional AX-name gap (the App executor's `accessibility.mjs`), joined to
//! the exact existing ref in Butler's world.
use super::{js::js_string, page::Page, state::Frame};
use serde_json::{Value, json};

/// A grid-sampled control named only by its geometry: `icon 24×24 at …`.
pub(crate) fn is_geometric(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("icon ") else {
        return false;
    };
    let Some((size, tail)) = rest.split_once(" at ") else {
        return false;
    };
    let _ = tail;
    size.split_once('×').is_some_and(|(w, h)| {
        !w.is_empty()
            && !h.is_empty()
            && w.bytes().all(|b| b.is_ascii_digit())
            && h.bytes().all(|b| b.is_ascii_digit())
    })
}

/// The accessibility name of `reference`, also kept in the world for refs.
pub(crate) async fn accessible_name(page: &Page, frame: &Frame, reference: &str) -> Option<String> {
    let expression = format!(
        "globalThis.__butlerObservation?.refs.get({})?.deref()",
        json!(reference)
    );
    let evaluated = page
        .send_to(
            &frame.session,
            "Runtime.evaluate",
            json!({"contextId":frame.context,"expression":expression,"returnByValue":false}),
        )
        .await
        .ok()?;
    let object = evaluated["result"]["objectId"].as_str()?.to_owned();
    let name = name_of(page, frame, &object).await;
    let _ = page
        .send_to(
            &frame.session,
            "Runtime.releaseObject",
            json!({"objectId":object}),
        )
        .await;
    name
}

async fn name_of(page: &Page, frame: &Frame, object: &str) -> Option<String> {
    let described = page
        .send_to(
            &frame.session,
            "DOM.describeNode",
            json!({"objectId":object}),
        )
        .await
        .ok()?;
    let backend = described["node"]["backendNodeId"].clone();
    let tree = page
        .send_to(
            &frame.session,
            "Accessibility.getPartialAXTree",
            json!({"backendNodeId":backend,"fetchRelatives":false}),
        )
        .await
        .ok()?;
    let name = tree["nodes"]
        .as_array()?
        .iter()
        .find(|n| n["backendDOMNodeId"] == backend && n["ignored"] != true)?["name"]["value"]
        .as_str()?
        .to_owned();
    if name.trim().is_empty() {
        return None;
    }
    page.send_to(&frame.session, "Runtime.callFunctionOn", json!({"objectId":object,"arguments":[{"value":name}],
        "functionDeclaration":"function(name){const state=globalThis.__butlerObservation;if(state)(state.accessibleNames??=new WeakMap()).set(this,name)}"}))
        .await
        .ok()?;
    Some(name)
}

/// Replaces geometric names with accessibility names where the page has one.
pub(crate) async fn name_observation(page: &Page, frame: &Frame, result: &mut Value) {
    let count = result["nodes"].as_array().map_or(0, Vec::len);
    for index in 0..count {
        let node = &result["nodes"][index];
        let named = js_string(&node["name"]);
        if (node["actionable"] != true && node.get("value").is_none_or(Value::is_null))
            || node["secure"] == true
            || !is_geometric(&named)
        {
            continue;
        }
        let reference = js_string(&node["ref"]);
        let role = js_string(&node["role"]);
        let Some(name) = accessible_name(page, frame, &reference).await else {
            continue;
        };
        let before = format!("{role} {} [{reference}]", json!(named));
        let after = format!("{role} {} [{reference}]", json!(name));
        let text = js_string(&result["text"]).replacen(&before, &after, 1);
        result["text"] = json!(text);
        result["nodes"][index]["name"] = json!(name);
        result["nodes"][index]["name_source"] = json!("accessibility");
    }
}
