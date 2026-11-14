//! What the new chat reads from the server, and what it makes of it: the briefing
//! (`/new-chat-briefing`), the epic and its group, the project, and the wallpaper
//! (`mainScreenTheme.ts`, `projectWallpaper.ts`: the project's source, else the global one).
use butler_ds::ui::blocks::wallpaper::{ImageFit, WallpaperSource};
use butler_shell_client::ShellClient;
use serde_json::Value;

use crate::ui::source::wire::NewChatBriefing;

/// What the screen asks for.
pub(super) struct Want {
    pub(super) project_id: Option<String>,
    pub(super) epic_id: Option<String>,
    pub(super) briefing: bool,
}

/// The epic of an epic chat: its title and the plan it belongs to (`None`: the backlog).
#[derive(Clone)]
pub(super) struct EpicInfo {
    pub(super) title: String,
    pub(super) group: Option<String>,
}

/// The raw answers (`None`: the call failed).
pub(super) struct Fetched {
    settings: Option<Value>,
    navigation: Option<Value>,
    briefing: Option<Value>,
    epic: Option<EpicInfo>,
}

/// Runs the calls on the agent worker.
pub(super) async fn fetch(client: ShellClient, want: Want) -> Fetched {
    let settings = client.get_settings().await.ok();
    let navigation = match want.project_id {
        Some(_) => client.list_navigation().await.ok(),
        None => None,
    };
    let briefing = if want.briefing {
        client
            .get_new_chat_briefing(None, want.project_id.as_deref())
            .await
            .ok()
    } else {
        None
    };
    let epic = match want.epic_id {
        Some(id) => epic_info(&client, &id).await,
        None => None,
    };
    Fetched {
        settings,
        navigation,
        briefing,
        epic,
    }
}

fn title_of(value: &Value) -> Option<String> {
    value.get("title")?.as_str().map(str::to_owned)
}

async fn epic_info(client: &ShellClient, id: &str) -> Option<EpicInfo> {
    let epic = client.get_canon_epic(id).await.ok()?;
    let group = match epic.get("plan_id").and_then(Value::as_str) {
        Some(plan_id) => title_of(&client.get_canon_plan(plan_id).await.ok()?),
        None => None,
    };
    Some(EpicInfo {
        title: title_of(&epic)?,
        group,
    })
}

/// What the answers say, ready to draw.
#[derive(Clone)]
pub(super) struct Resolved {
    pub(super) briefing: Option<NewChatBriefing>,
    pub(super) epic: Option<EpicInfo>,
    pub(super) project_name: Option<String>,
    pub(super) wallpaper: WallpaperSource,
    pub(super) wallpaper_paused: bool,
}

pub(super) fn resolve(fetched: Fetched, project_id: Option<&str>) -> Resolved {
    let briefing: Option<NewChatBriefing> = fetched
        .briefing
        .and_then(|value| serde_json::from_value(value).ok());
    let project = project_id.and_then(|id| {
        fetched
            .navigation
            .as_ref()?
            .get("projects")?
            .as_array()?
            .iter()
            .find(|project| project.get("id").and_then(Value::as_str) == Some(id))
            .cloned()
    });
    let project_name = project
        .as_ref()
        .and_then(|project| project.get("display_name")?.as_str().map(str::to_owned))
        .or_else(|| briefing.as_ref()?.source.as_ref()?.project_name.clone());
    let own = project
        .as_ref()
        .and_then(|project| parse_source(project.get("wallpaper")?));
    let settings = fetched.settings.unwrap_or(Value::Null);
    let wallpaper = own.unwrap_or_else(|| global_source(&settings));
    let wallpaper_paused = settings["wallpaper"]["motion"] == "paused";
    Resolved {
        briefing,
        epic: fetched.epic,
        project_name,
        wallpaper,
        wallpaper_paused,
    }
}

/// `mainScreenWallpaper`: the `wallpaper` setting's source, or the legacy keys'.
fn global_source(settings: &Value) -> WallpaperSource {
    settings
        .get("wallpaper")
        .and_then(|wallpaper| parse_source(wallpaper.get("source")?))
        .unwrap_or_else(|| legacy_source(settings))
}

/// A JSON number as the nearest `f32`.
fn f32_of(value: &Value) -> Option<f32> {
    value.as_f64()?.to_string().parse().ok()
}

/// `parseWallpaperSource`, without module params and filters.
fn parse_source(value: &Value) -> Option<WallpaperSource> {
    match value.get("kind")?.as_str()? {
        "none" => Some(WallpaperSource::None),
        "live" => {
            let module = value.get("module")?.as_str().filter(|m| !m.is_empty())?;
            Some(WallpaperSource::Live {
                module: module.to_owned().into(),
            })
        }
        "image" => {
            let fit = match value.get("fit")?.as_str()? {
                "cover" => ImageFit::Cover,
                "contain" => ImageFit::Contain,
                _ => return None,
            };
            Some(WallpaperSource::Image {
                asset: value.get("asset")?.as_str()?.to_owned().into(),
                fit,
                dim: f32_of(value.get("dim")?)?,
                blur: f32_of(value.get("blur")?)?,
            })
        }
        _ => None,
    }
}

fn custom_colors(settings: &Value) -> bool {
    let valid = |color: &Value| {
        color.as_str().is_some_and(|color| {
            let color = color.trim();
            color.len() == 7
                && color.starts_with('#')
                && color[1..].chars().all(|c| c.is_ascii_hexdigit())
        })
    };
    settings
        .get("main_screen_theme_custom_colors")
        .and_then(Value::as_array)
        .is_some_and(|colors| colors.len() == 6 && colors.iter().all(valid))
}

/// `legacyWallpaperSource`: the `main_screen_theme*` keys.
fn legacy_source(settings: &Value) -> WallpaperSource {
    let live = |module: &str| WallpaperSource::Live {
        module: module.to_owned().into(),
    };
    let text = |key: &str| {
        settings
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    match (text("main_screen_theme"), text("main_screen_theme_preset")) {
        ("none", _) => WallpaperSource::None,
        ("silk" | "curtain", _) => live("butler.silk"),
        (_, "aurora" | "bloom" | "lavender" | "morning") => live("butler.bloom"),
        (_, "custom") if custom_colors(settings) => live("butler.bloom"),
        _ => live("butler.riso-print"),
    }
}
