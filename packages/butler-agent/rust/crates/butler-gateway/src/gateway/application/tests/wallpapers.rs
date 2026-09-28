use std::path::PathBuf;

use bytes::Bytes;
use image::{ExtendedColorType, ImageEncoder, Rgba, RgbaImage, codecs::png::PngEncoder};

use super::*;
use crate::gateway::{
    AppFileUpload, AppMessageFiles, AppWallpaperAsset, AppWallpaperVariant, GatewayWallpapers,
};

pub(super) struct Fixture {
    pub(super) app: AppApplication,
    pub(super) data: PathBuf,
    files: Arc<AppMessageFiles>,
}

/// An App over its own temporary data directory with real message files.
pub(super) async fn open(label: &str) -> Fixture {
    let data = std::env::temp_dir().join(format!(
        "butler-wallpapers-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&data).unwrap();
    let files = Arc::new(AppMessageFiles::new(
        &data,
        Arc::new(Clock(AtomicU64::new(900))),
    ));
    let mut dependencies = dependencies(Arc::new(Native(Mutex::new(Vec::new()))), 1);
    dependencies.message_files = files.clone();
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: data.join("app.sqlite"),
            butler_data: data.clone(),
            project_workspace_root: data.clone(),
            folder_selection_secret: None,
        },
        dependencies,
    )
    .await
    .unwrap();
    Fixture { app, data, files }
}

impl Fixture {
    pub(super) async fn close(self) {
        self.app.close().await.unwrap();
        self.files.close().await.unwrap();
        std::fs::remove_dir_all(self.data).unwrap();
    }

    fn directory(&self) -> PathBuf {
        self.data.join("app-server/wallpapers")
    }

    pub(super) async fn upload(&self, width: u32, height: u32) -> AppWallpaperAsset {
        let image = RgbaImage::from_pixel(width, height, Rgba([200, 120, 40, 255]));
        self.app.upload_wallpaper(png(&image)).await.unwrap()
    }
}

pub(super) fn png(image: &RgbaImage) -> Bytes {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .unwrap();
    bytes.into()
}

pub(super) fn public_code(error: GatewayApplicationError) -> (u16, String, String) {
    match error {
        GatewayApplicationError::Public {
            status,
            code,
            message,
            ..
        } => (status, code, message),
        other @ GatewayApplicationError::Internal { .. } => {
            panic!("expected a public error, got {other:?}")
        }
    }
}

fn image_source(asset: &str) -> Value {
    json!({"source": {"kind": "image", "asset": asset, "fit": "cover", "dim": 0.2, "blur": 0}})
}

#[tokio::test]
async fn uploads_are_stored_listed_newest_first_and_read_back() {
    let fixture = open("upload").await;
    let first = fixture.upload(1000, 500).await;
    assert!(
        first.id.starts_with("wp_") && first.id.len() == 35,
        "{}",
        first.id
    );
    assert!(
        first.id[3..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    assert_eq!((first.width, first.height), (1000, 500));
    assert_eq!(first.color, "#c87828");
    assert!(
        first.luminance > 0.2 && first.luminance < 0.4,
        "{}",
        first.luminance
    );
    assert_eq!(first.created_at, "2026-09-14T00:00:00.000Z");
    let image_path = fixture.directory().join(format!("{}.jpg", first.id));
    assert_eq!(std::fs::metadata(&image_path).unwrap().len(), first.bytes);
    assert!(
        fixture
            .directory()
            .join(format!("{}.thumb.jpg", first.id))
            .exists()
    );

    let second = fixture.upload(64, 64).await;
    assert_ne!(first.id, second.id);
    let listed = fixture.app.list_wallpapers().await.unwrap();
    assert_eq!(listed, vec![second.clone(), first.clone()]);

    let image = fixture
        .app
        .read_wallpaper(first.id.clone(), AppWallpaperVariant::Image)
        .await
        .unwrap();
    assert_eq!(image.mime_type, "image/jpeg");
    assert_eq!(image.bytes.as_ref(), std::fs::read(&image_path).unwrap());
    let thumbnail = fixture
        .app
        .read_wallpaper(first.id.clone(), AppWallpaperVariant::Thumbnail)
        .await
        .unwrap();
    assert_eq!(thumbnail.mime_type, "image/jpeg");
    assert_ne!(thumbnail.etag, image.etag);
    let decoded = image::load_from_memory(&thumbnail.bytes).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (480, 240));
    fixture.close().await;
}

#[tokio::test]
async fn rejected_uploads_and_unknown_ids_leave_no_asset() {
    let fixture = open("rejected").await;
    let error = fixture
        .app
        .upload_wallpaper(Bytes::from_static(b"not an image, whatever the name says"))
        .await
        .unwrap_err();
    assert_eq!(public_code(error).0, 415);
    assert!(fixture.app.list_wallpapers().await.unwrap().is_empty());
    assert!(
        !fixture.directory().exists()
            || std::fs::read_dir(fixture.directory()).unwrap().count() == 0
    );
    for id in ["wp_missing000", "../app.sqlite", "wp_../../x"] {
        for variant in [AppWallpaperVariant::Image, AppWallpaperVariant::Thumbnail] {
            let error = fixture
                .app
                .read_wallpaper(id.into(), variant)
                .await
                .err()
                .unwrap();
            assert_eq!(public_code(error).1, "wallpaper_not_found");
        }
        let error = fixture.app.delete_wallpaper(id.into()).await.unwrap_err();
        assert_eq!(public_code(error).1, "wallpaper_not_found");
    }
    fixture.close().await;
}

#[tokio::test]
async fn delete_refuses_an_asset_the_wallpaper_setting_uses() {
    let fixture = open("delete").await;
    let asset = fixture.upload(32, 16).await;
    fixture
        .app
        .update_settings_owned(json!({"wallpaper": image_source(&asset.id)}))
        .await
        .unwrap();
    let error = fixture
        .app
        .delete_wallpaper(asset.id.clone())
        .await
        .unwrap_err();
    let (status, code, message) = public_code(error);
    assert_eq!((status, code.as_str()), (409, "wallpaper_in_use"));
    assert!(message.contains("settings.wallpaper"), "{message}");
    assert_eq!(
        fixture.app.list_wallpapers().await.unwrap(),
        vec![asset.clone()]
    );

    fixture
        .app
        .update_settings_owned(json!({"wallpaper": {"source": {"kind": "none"}}}))
        .await
        .unwrap();
    let deleted = fixture
        .app
        .delete_wallpaper(asset.id.clone())
        .await
        .unwrap();
    assert_eq!(deleted, asset);
    assert!(fixture.app.list_wallpapers().await.unwrap().is_empty());
    assert_eq!(std::fs::read_dir(fixture.directory()).unwrap().count(), 0);
    let error = fixture
        .app
        .read_wallpaper(asset.id, AppWallpaperVariant::Image)
        .await
        .err()
        .unwrap();
    assert_eq!(public_code(error).1, "wallpaper_not_found");
    fixture.close().await;
}

#[tokio::test]
async fn settings_patch_rejects_an_image_source_with_an_unknown_asset() {
    let fixture = open("patch").await;
    let before = fixture.app.worker_profile_settings().await.unwrap();
    let error = fixture
        .app
        .update_settings_owned(json!({"wallpaper": image_source("wp_unknown0000")}))
        .await
        .unwrap_err();
    let (status, code, message) = public_code(error);
    assert_eq!((status, code.as_str()), (400, "settings_wallpaper_invalid"));
    assert!(message.contains("wallpaper.source.asset"), "{message}");
    assert_eq!(fixture.app.worker_profile_settings().await.unwrap(), before);
    let updates = fixture.app.replay_events(0.0, 500).await.unwrap();
    assert!(
        updates
            .iter()
            .all(|event| event.event_type != "settings.updated")
    );

    let asset = fixture.upload(8, 8).await;
    let updated = fixture
        .app
        .update_settings_owned(json!({"wallpaper": image_source(&asset.id)}))
        .await
        .unwrap();
    assert_eq!(updated["wallpaper"]["source"]["asset"], json!(asset.id));
    fixture.close().await;
}

#[tokio::test]
async fn message_files_promote_through_the_upload_pipeline() {
    let fixture = open("promote").await;
    let photo = fixture
        .app
        .upload_message_file(AppFileUpload {
            owner_session_id: None,
            name: "photo.png".into(),
            mime_type: Some("image/png".into()),
            bytes: png(&RgbaImage::from_pixel(800, 400, Rgba([0, 0, 0, 255]))),
        })
        .await
        .unwrap();
    let asset = fixture
        .app
        .promote_message_file_to_wallpaper(photo.file_id.clone())
        .await
        .unwrap();
    assert!(asset.id.starts_with("wp_"));
    assert_eq!((asset.width, asset.height), (800, 400));
    assert_eq!((asset.luminance, asset.color.as_str()), (0.0, "#000000"));
    assert_eq!(fixture.app.list_wallpapers().await.unwrap(), vec![asset]);

    let notes = fixture
        .app
        .upload_message_file(AppFileUpload {
            owner_session_id: None,
            name: "notes.txt".into(),
            mime_type: Some("text/plain".into()),
            bytes: Bytes::from_static(b"plain text"),
        })
        .await
        .unwrap();
    let error = fixture
        .app
        .promote_message_file_to_wallpaper(notes.file_id)
        .await
        .unwrap_err();
    assert_eq!(public_code(error).1, "wallpaper_unsupported_type");
    let error = fixture
        .app
        .promote_message_file_to_wallpaper("file-00000000-0000-4000-8000-000000000999".into())
        .await
        .unwrap_err();
    assert_eq!(public_code(error).1, "message_file_not_found");
    assert_eq!(fixture.app.list_wallpapers().await.unwrap().len(), 1);
    fixture.close().await;
}
