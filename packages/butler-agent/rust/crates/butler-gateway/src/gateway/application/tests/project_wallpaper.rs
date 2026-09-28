//! Per-project wallpaper: `dashboard_preferences_json.wallpaper`, its summary
//! projection, and the asset reference it holds.

use super::wallpapers::{Fixture, open, public_code};
use super::*;
use crate::gateway::{
    AppCreateProjectRequest, AppProjectDashboardPreferencesUpdate, AppProjectSource,
    GatewayWallpapers,
};

pub(super) async fn create_project(fixture: &Fixture, name: &str) -> String {
    fixture
        .app
        .create_project_owned(AppCreateProjectRequest {
            source: AppProjectSource::Scratch,
            display_name: Some(name.into()),
            folder_selection_token: None,
        })
        .await
        .unwrap()
        .project
        .id
}

fn wallpaper_update(
    expected_revision: u64,
    wallpaper: Value,
) -> AppProjectDashboardPreferencesUpdate {
    AppProjectDashboardPreferencesUpdate {
        expected_revision,
        description: None,
        pinned_source_refs: None,
        wallpaper: Some(wallpaper),
    }
}

async fn set_wallpaper(
    fixture: &Fixture,
    project: &str,
    expected_revision: u64,
    wallpaper: Value,
) -> Result<Value, GatewayApplicationError> {
    fixture
        .app
        .update_project_dashboard_preferences_owned(
            project.to_owned(),
            wallpaper_update(expected_revision, wallpaper),
        )
        .await
}

/// The wallpaper each listed project summary carries, by project id.
async fn summary_wallpaper(fixture: &Fixture, project: &str) -> Value {
    let list = fixture.app.list_projects(false).await.unwrap();
    let summary = list
        .projects
        .iter()
        .find(|summary| summary.id == project)
        .unwrap();
    serde_json::to_value(summary).unwrap()["wallpaper"].clone()
}

async fn project_updates(fixture: &Fixture) -> Vec<Value> {
    fixture
        .app
        .replay_events(0.0, 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "project.updated")
        .map(|event| Value::Object(event.payload))
        .collect()
}

fn image(asset: &str) -> Value {
    json!({"kind": "image", "asset": asset, "fit": "cover", "dim": 0.25, "blur": 0})
}

#[tokio::test]
async fn project_wallpaper_defaults_to_inherit() {
    let fixture = open("project-inherit").await;
    let project = create_project(&fixture, "Atlas").await;
    assert_eq!(
        summary_wallpaper(&fixture, &project).await,
        json!("inherit")
    );
    let dashboard = fixture
        .app
        .get_project_dashboard_owned(project.clone())
        .await
        .unwrap();
    assert_eq!(dashboard["preferences"]["wallpaper"], json!("inherit"));
    assert_eq!(dashboard["project"]["wallpaper"], json!("inherit"));
    fixture.close().await;
}

#[tokio::test]
async fn project_wallpaper_patch_stores_sources_and_emits_project_updated() {
    let fixture = open("project-patch").await;
    let project = create_project(&fixture, "Atlas").await;
    fixture
        .app
        .update_project_dashboard_preferences_owned(
            project.clone(),
            AppProjectDashboardPreferencesUpdate {
                expected_revision: 0,
                description: Some("Maps.".into()),
                pinned_source_refs: None,
                wallpaper: None,
            },
        )
        .await
        .unwrap();
    let live = json!({"kind": "live", "module": "butler.sumi", "params": {"speed": 0.1}});
    let revision = set_wallpaper(&fixture, &project, 1, live.clone())
        .await
        .unwrap();
    assert_eq!(revision, json!({"revision": 2}));
    let dashboard = fixture
        .app
        .get_project_dashboard_owned(project.clone())
        .await
        .unwrap();
    assert_eq!(dashboard["description"], json!("Maps."));
    assert_eq!(
        dashboard["preferences"],
        json!({"revision": 2, "pinnedSourceRefs": [], "wallpaper": live})
    );
    assert_eq!(summary_wallpaper(&fixture, &project).await, live);
    let updates = project_updates(&fixture).await;
    assert_eq!(updates.last().unwrap()["project"]["wallpaper"], live);

    for (revision, wallpaper) in [(2, json!({"kind": "none"})), (3, json!("inherit"))] {
        set_wallpaper(&fixture, &project, revision, wallpaper.clone())
            .await
            .unwrap();
        assert_eq!(summary_wallpaper(&fixture, &project).await, wallpaper);
        let updates = project_updates(&fixture).await;
        assert_eq!(updates.last().unwrap()["project"]["wallpaper"], wallpaper);
    }
    fixture.close().await;
}

#[tokio::test]
async fn project_wallpaper_patch_rejects_invalid_values_naming_the_field() {
    let fixture = open("project-invalid").await;
    let project = create_project(&fixture, "Atlas").await;
    let before = project_updates(&fixture).await.len();
    let cases = [
        (json!(null), "wallpaper must be \"inherit\" or"),
        (json!("global"), "wallpaper must be \"inherit\" or"),
        (json!({"kind": "video"}), "wallpaper.kind must be"),
        (json!({"kind": "live"}), "wallpaper.module is required"),
        (
            json!({"kind": "live", "module": "Bloom"}),
            "wallpaper.module must match",
        ),
        (
            json!({"kind": "none", "motion": "auto"}),
            "wallpaper.motion is not supported",
        ),
        (
            json!({"kind": "image", "asset": "wp_x", "fit": "cover", "dim": 0, "blur": 0}),
            "wallpaper.asset must match",
        ),
        (
            json!({"kind": "image", "asset": "wp_abcdefgh", "fit": "fill", "dim": 0, "blur": 0}),
            "wallpaper.fit must be",
        ),
        (
            image("wp_unknown0000"),
            "wallpaper.asset must name a stored wallpaper image",
        ),
    ];
    for (wallpaper, expected) in cases {
        let error = set_wallpaper(&fixture, &project, 0, wallpaper.clone())
            .await
            .unwrap_err();
        let (status, code, message) = public_code(error);
        assert_eq!((status, code.as_str()), (400, "project_wallpaper_invalid"));
        assert!(message.contains(expected), "{wallpaper}: {message}");
    }
    let dashboard = fixture
        .app
        .get_project_dashboard_owned(project.clone())
        .await
        .unwrap();
    assert_eq!(dashboard["preferences"]["revision"], json!(0));
    assert_eq!(dashboard["preferences"]["wallpaper"], json!("inherit"));
    assert_eq!(project_updates(&fixture).await.len(), before);
    fixture.close().await;
}

#[tokio::test]
async fn project_wallpaper_patch_conflicts_on_a_stale_revision() {
    let fixture = open("project-conflict").await;
    let project = create_project(&fixture, "Atlas").await;
    set_wallpaper(&fixture, &project, 0, json!({"kind": "none"}))
        .await
        .unwrap();
    let before = project_updates(&fixture).await.len();
    let stale = json!({"kind": "live", "module": "butler.silk"});
    let error = set_wallpaper(&fixture, &project, 0, stale)
        .await
        .unwrap_err();
    let (status, code, _) = public_code(error);
    assert_eq!((status, code.as_str()), (409, "preferences_changed"));
    assert_eq!(
        summary_wallpaper(&fixture, &project).await,
        json!({"kind": "none"})
    );
    assert_eq!(project_updates(&fixture).await.len(), before);
    fixture.close().await;
}

#[tokio::test]
async fn delete_refuses_an_asset_a_project_wallpaper_uses() {
    let fixture = open("project-delete").await;
    let asset = fixture.upload(32, 16).await;
    let project = create_project(&fixture, "Atlas").await;
    set_wallpaper(&fixture, &project, 0, image(&asset.id))
        .await
        .unwrap();
    assert_eq!(
        summary_wallpaper(&fixture, &project).await,
        image(&asset.id)
    );
    let error = fixture
        .app
        .delete_wallpaper(asset.id.clone())
        .await
        .unwrap_err();
    let (status, code, message) = public_code(error);
    assert_eq!((status, code.as_str()), (409, "wallpaper_in_use"));
    assert!(
        message.contains(&format!("projects.{project}.wallpaper")),
        "{message}"
    );
    assert_eq!(
        fixture.app.list_wallpapers().await.unwrap(),
        vec![asset.clone()]
    );

    set_wallpaper(&fixture, &project, 1, json!("inherit"))
        .await
        .unwrap();
    let deleted = fixture
        .app
        .delete_wallpaper(asset.id.clone())
        .await
        .unwrap();
    assert_eq!(deleted, asset);
    let error = set_wallpaper(&fixture, &project, 2, image(&asset.id))
        .await
        .unwrap_err();
    assert_eq!(public_code(error).1, "project_wallpaper_invalid");
    fixture.close().await;
}
