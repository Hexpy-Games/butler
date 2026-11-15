//! Viewer and native export harness commands use API records and the production pipeline.
use super::{Harness, ui};
use anyhow::Context as _;
use ui::browser::model::BrowserState;

pub(super) fn command(
    h: &mut Harness,
    dir: &std::path::Path,
    command: &str,
    arg: &str,
) -> anyhow::Result<()> {
    match command {
        "artifact-open" => {
            let artifact: ui::source::wire::SessionArtifactSummary = serde_json::from_str(arg)?;
            let session = artifact.session_id.clone().context("artifact session")?;
            h.update(|s, w, cx| {
                super::open_chat(s, &session, w, cx);
                ui::viewer::open(
                    cx,
                    &session,
                    ui::viewer::FileViewerEntry::Artifact {
                        id: artifact.id.clone(),
                        artifact: Box::new(artifact),
                    },
                );
            })
        }
        "embed-frame" => h.update(|_, _, cx| {
            let state = cx.global::<BrowserState>();
            let frames: Vec<_> = state
                .embeds
                .keys()
                .map(|id| {
                    let size = state.frame_size(id);
                    let pixel = size.and_then(|(w, h)| state.frame_pixel(id, w / 2, h / 2));
                    serde_json::json!({"id": id.0.as_ref(), "size":size, "pixel":pixel})
                })
                .collect();
            std::fs::write(
                dir.join("embed-frame.json"),
                serde_json::to_vec(&serde_json::json!({"embeds":frames})).unwrap_or_default(),
            )
            .ok();
        }),
        "document-export" => {
            let (path, raw) = arg
                .split_once(' ')
                .context("document-export path and JSON")?;
            let doc = serde_json::from_str(raw)?;
            h.update(|_, _, cx| ui::manage::documents::pdf::save(doc, path.into(), cx))
        }
        _ => anyhow::bail!("unknown artifact command"),
    }
}
