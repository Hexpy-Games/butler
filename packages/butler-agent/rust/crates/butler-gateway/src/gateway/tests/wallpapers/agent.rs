//! The module listing and the agent's wallpaper route over HTTP.

use super::*;

#[tokio::test]
async fn module_listing_serves_the_selectable_manifests() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let anonymous = call(address, "GET /wallpaper-modules", &[], &[]).await;
    assert_eq!(anonymous.status, 401);
    let listed = authorized(address, "GET /wallpaper-modules", &[]).await;
    assert_eq!(listed.status, 200);
    let modules = listed.json()["data"]["modules"].clone();
    let ids: Vec<_> = modules
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].clone())
        .collect();
    assert!(ids.contains(&json!("butler.bloom")), "{ids:?}");
    assert!(!ids.contains(&json!("butler.image")), "{ids:?}");
    let bloom = modules
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "butler.bloom")
        .unwrap();
    assert_eq!(bloom["params"][0]["key"], "colors");
    let wrong = authorized(address, "POST /wallpaper-modules", b"{}").await;
    assert_eq!(failure(&wrong), (404, "not_found".into()));
    harness.close().await;
}

#[tokio::test]
async fn agent_route_sets_wallpapers_and_returns_correctable_rejections() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let body = json!({"scope": "global", "source": {"kind": "live", "module": "butler.silk"}});
    let anonymous = call(
        address,
        "POST /internal/wallpaper",
        &[],
        body.to_string().as_bytes(),
    )
    .await;
    assert_eq!(anonymous.status, 401);
    let set = authorized(
        address,
        "POST /internal/wallpaper",
        body.to_string().as_bytes(),
    )
    .await;
    assert_eq!(set.status, 200, "{}", String::from_utf8_lossy(&set.body));
    let change = set.json()["data"].clone();
    assert_eq!(change["scope"], "global");
    assert_eq!(
        change["next"],
        json!({"kind": "live", "module": "butler.silk"})
    );
    assert_eq!(change["changed"], json!(true));
    assert!(change.get("projectId").is_none());
    let settings = authorized(address, "GET /settings", &[]).await;
    assert_eq!(
        settings.json()["data"]["wallpaper"]["source"],
        change["next"]
    );

    let body = json!({"scope": "global",
        "source": {"kind": "live", "module": "butler.bloom", "params": {"warmth": 0.8}}});
    let refused = authorized(
        address,
        "POST /internal/wallpaper",
        body.to_string().as_bytes(),
    )
    .await;
    assert_eq!(refused.status, 400);
    let error = refused.json()["error"].clone();
    assert_eq!(error["code"], "wallpaper_invalid");
    assert_eq!(error["field"], "source.params.warmth");
    assert_eq!(error["allowed"], json!(["colors"]));
    assert_eq!(
        error["message"],
        "source.params.warmth is not a parameter of butler.bloom. Allowed: colors."
    );
    assert!(refused.json().get("protocol_version").is_some());

    let body = json!({"scope": "everywhere", "source": {"kind": "none"}});
    let malformed = authorized(
        address,
        "POST /internal/wallpaper",
        body.to_string().as_bytes(),
    )
    .await;
    assert_eq!(
        failure(&malformed),
        (400, "wallpaper_request_invalid".into())
    );
    harness.close().await;
}

#[tokio::test]
async fn agent_overview_reads_the_project_wallpaper_it_set() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let body = json!({"source": "scratch", "display_name": "Atlas"}).to_string();
    let created = authorized(address, "POST /projects", body.as_bytes()).await;
    let project = created.json()["data"]["project"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sumi = json!({"kind": "none"});
    let body = json!({"scope": "project", "project_id": project, "source": sumi});
    let set = authorized(
        address,
        "POST /internal/wallpaper",
        body.to_string().as_bytes(),
    )
    .await;
    assert_eq!(set.status, 200, "{}", String::from_utf8_lossy(&set.body));
    assert_eq!(set.json()["data"]["projectId"], json!(project));
    assert_eq!(set.json()["data"]["previous"], json!("inherit"));

    let path = format!("GET /internal/wallpaper?project_id={project}");
    let overview = authorized(address, &path, &[]).await;
    assert_eq!(overview.status, 200);
    let data = overview.json()["data"].clone();
    assert_eq!(
        data["project"],
        json!({"id": project, "wallpaper": sumi, "effective": sumi})
    );
    assert!(
        data["modules"]
            .as_array()
            .is_some_and(|modules| !modules.is_empty())
    );
    assert_eq!(data["images"], json!([]));
    let global = authorized(address, "GET /internal/wallpaper", &[]).await;
    assert!(global.json()["data"].get("project").is_none());
    let unknown = authorized(address, "GET /internal/wallpaper?project_id=nowhere", &[]).await;
    assert_eq!(failure(&unknown), (404, "project_not_found".into()));
    let body = json!({"scope": "project", "project_id": "nowhere", "source": {"kind": "none"}});
    let missing = authorized(
        address,
        "POST /internal/wallpaper",
        body.to_string().as_bytes(),
    )
    .await;
    assert_eq!(
        (missing.status, missing.json()["error"]["field"].clone()),
        (404, json!("project_id"))
    );
    harness.close().await;
}
