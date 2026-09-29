//! Wallpaper asset files under `<data>/app-server/wallpapers`, kept apart from
//! message files and their lifecycle, and the user module folders under
//! `<data>/wallpapers` with their watcher. AppApplication owns the metadata
//! rows; this owner runs the image pipeline and file I/O on a bounded
//! blocking lane that shutdown waits for.

mod files;
mod pipeline;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use bytes::Bytes;
use parking_lot::Mutex;
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use super::{
    AppWallpaperVariant, ApplicationFuture, GatewayApplicationError,
    wallpaper_modules::{
        import::{self, Unpacked},
        user::{self, FileRead, UserModule},
        watch::{self, ModuleWatcher, ModulesChanged},
    },
};

/// What [`AppWallpaperFiles::store`] wrote for one asset.
pub(crate) struct StoredWallpaper {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bytes: u64,
    pub(crate) mime_type: String,
    pub(crate) thumbnail_mime_type: String,
    pub(crate) luminance: f64,
    pub(crate) color: String,
}

/// One pointer wide: AppApplication handles are moved through command enums.
#[derive(Clone)]
pub(crate) struct AppWallpaperFiles(Arc<Lane>);

struct Lane {
    root: PathBuf,
    modules: PathBuf,
    permits: Arc<Semaphore>,
    /// One image decode at a time: each may hold a few hundred MB.
    decodes: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Mutex<bool>,
    watcher: Mutex<Option<ModuleWatcher>>,
}

impl AppWallpaperFiles {
    pub(crate) fn new(data_root: &Path) -> Self {
        Self(Arc::new(Lane {
            root: data_root.join("app-server/wallpapers"),
            modules: data_root.join("wallpapers"),
            permits: Arc::new(Semaphore::new(2)),
            decodes: Arc::new(Semaphore::new(1)),
            jobs: TaskTracker::new(),
            closing: Mutex::new(false),
            watcher: Mutex::new(None),
        }))
    }

    /// Where user modules live: `<data>/wallpapers`.
    pub(crate) fn modules_root(&self) -> &Path {
        &self.0.modules
    }

    pub(crate) async fn close(&self) {
        {
            let mut closing = self.0.closing.lock();
            *closing = true;
            self.0.permits.close();
            self.0.decodes.close();
            self.0.jobs.close();
        }
        self.0.watcher.lock().take();
        self.0.jobs.wait().await;
    }

    /// Reports module folder changes to `changed` until close, after sweeping
    /// what an interrupted install left. Best effort: without a watcher,
    /// listings still read the folders as they are.
    pub(crate) fn watch_modules(&self, changed: ModulesChanged) {
        let closing = self.0.closing.lock();
        let mut slot = self.0.watcher.lock();
        if !*closing && slot.is_none() {
            import::sweep(&self.0.modules);
            *slot = watch::watch(&self.0.modules, changed).ok();
        }
    }

    /// Every user module folder, as its files are now.
    pub(crate) fn user_modules(&self) -> ApplicationFuture<Vec<UserModule>> {
        self.run_in(self.0.modules.clone(), |root| {
            user::scan(root).map_err(GatewayApplicationError::internal_from)
        })
    }

    pub(crate) fn user_module(&self, id: String) -> ApplicationFuture<Option<UserModule>> {
        self.run_in(self.0.modules.clone(), move |root| {
            user::read(root, &id).map_err(GatewayApplicationError::internal_from)
        })
    }

    /// The image `name` of user module `id`, which a save replacing the
    /// module keeps.
    pub(crate) fn existing_image(&self, id: String, name: String) -> ApplicationFuture<FileRead> {
        self.run_in(self.0.modules.clone(), move |root| {
            user::existing_image(root, &id, &name).map_err(GatewayApplicationError::internal_from)
        })
    }

    /// Checks a module archive and installs it; an installed copy is
    /// replaced only with `replace`.
    pub(crate) fn install_module(
        &self,
        archive: Bytes,
        unique: String,
        replace: bool,
    ) -> ApplicationFuture<UserModule> {
        self.run_in(self.0.modules.clone(), move |root| {
            installed(root, &import::unpack(&archive)?, &unique, replace)
        })
    }

    /// Installs checked module files at once, replacing an older copy (the
    /// caller checked that it may).
    pub(crate) fn write_module(
        &self,
        unpacked: Unpacked,
        unique: String,
    ) -> ApplicationFuture<UserModule> {
        self.run_in(self.0.modules.clone(), move |root| {
            installed(root, &unpacked, &unique, true)
        })
    }

    /// Removes a user module folder; false when there is none.
    pub(crate) fn remove_module(&self, id: String, unique: String) -> ApplicationFuture<bool> {
        self.run_in(self.0.modules.clone(), move |root| {
            import::remove(root, &id, &unique)
        })
    }

    /// Validates, re-encodes and writes one asset's image and thumbnail.
    /// Decodes run one at a time.
    pub(crate) fn store(&self, id: String, source: Bytes) -> ApplicationFuture<StoredWallpaper> {
        let decodes = Arc::clone(&self.0.decodes);
        let stored = self.run(move |root| {
            let processed = pipeline::process(&source)?;
            drop(source);
            files::write(root, &id, &processed)?;
            Ok(StoredWallpaper {
                width: processed.image.width,
                height: processed.image.height,
                bytes: processed.image.bytes.len() as u64,
                mime_type: processed.image.mime_type.to_owned(),
                thumbnail_mime_type: processed.thumbnail.mime_type.to_owned(),
                luminance: processed.luminance,
                color: processed.color,
            })
        });
        Box::pin(async move {
            let _decode = decodes
                .acquire_owned()
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            stored.await
        })
    }

    pub(crate) fn read(
        &self,
        id: String,
        mime_type: String,
        variant: AppWallpaperVariant,
    ) -> ApplicationFuture<Bytes> {
        self.run(move |root| files::read(root, &id, &mime_type, variant))
    }

    pub(crate) fn remove(
        &self,
        id: String,
        mime_type: String,
        thumbnail_mime_type: String,
    ) -> ApplicationFuture<()> {
        self.run(move |root| files::remove(root, &id, &mime_type, &thumbnail_mime_type))
    }

    fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&Path) -> Result<T, GatewayApplicationError> + Send + 'static,
    ) -> ApplicationFuture<T> {
        self.run_in(self.0.root.clone(), operation)
    }

    /// Runs `operation` on the blocking lane with `root`.
    fn run_in<T: Send + 'static>(
        &self,
        root: PathBuf,
        operation: impl FnOnce(&Path) -> Result<T, GatewayApplicationError> + Send + 'static,
    ) -> ApplicationFuture<T> {
        let lane = Arc::clone(&self.0);
        Box::pin(async move {
            let permit = Arc::clone(&lane.permits)
                .acquire_owned()
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            let (send, receive) = oneshot::channel();
            // As for message files: close and registration share a lock, so a
            // cancelled caller cannot detach a write from shutdown.
            {
                let closing = lane.closing.lock();
                if *closing {
                    return Err(GatewayApplicationError::internal());
                }
                lane.jobs.spawn(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        operation(&root)
                    })
                    .await
                    .map_err(GatewayApplicationError::internal_from)
                    .and_then(|result| result);
                    let _ = send.send(result);
                });
            }
            receive
                .await
                .map_err(GatewayApplicationError::internal_from)?
        })
    }
}

/// Installs `unpacked` under `root` (staged, then moved into place) and reads
/// the installed module back.
fn installed(
    root: &Path,
    unpacked: &Unpacked,
    unique: &str,
    replace: bool,
) -> Result<UserModule, GatewayApplicationError> {
    import::install(root, unpacked, unique, replace)?;
    user::read(root, &unpacked.module.id)
        .map_err(GatewayApplicationError::internal_from)?
        .ok_or_else(GatewayApplicationError::internal)
}
