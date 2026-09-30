//! User wallpaper modules at the App: listing with the App's last check of
//! the current files, status reports, import, the agent's saves, deletion
//! while unused, the modules an agent may choose, and
//! `wallpaper.modules.updated` events. Import, saves and deletion hold the
//! settings update lock, so they serialize with each other and with settings
//! writes that could start using a module.
//!
//! A save waits for the App's check the way the App delivers it: the folder
//! watcher announces the new files, the App compiles them and reports a
//! status for their revision. The save polls for that status until
//! [`SAVE_CHECK_WAIT`] runs out, and then answers `unknown`: the App checks
//! modules only while its window is open.

use std::{collections::HashMap, sync::Arc, time::Duration};

use bytes::Bytes;
use serde_json::{Map, Value, json};

use super::super::{app_error, events};
use super::{module_status, references};
use crate::gateway::{
    AppApplication, AppWallpaperFile, AppWallpaperModuleShader, AppWallpaperModuleStatusReport,
    AppWallpaperRejection, GatewayApplicationError,
    wallpaper_modules::{
        WallpaperModules, describe_for_agent, save,
        user::{FileRead, ModuleStatus, UserModule},
    },
    wallpapers::{AppWallpaperModuleSaveRequest, AppWallpaperModuleSaved, module_not_found},
};

pub(in crate::gateway::application) const MODULES_UPDATED: &str = "wallpaper.modules.updated";
/// Longest status message kept, in characters (compile logs can be long).
const MAX_MESSAGE_CHARS: usize = 2000;
/// How long a save waits for the App's check of the files it wrote.
pub(in crate::gateway::application) const SAVE_CHECK_WAIT: Duration = Duration::from_secs(10);
/// How often a waiting save looks for that check.
const CHECK_POLL: Duration = Duration::from_millis(100);
const UNCHECKED: &str = "The App has not checked these files yet. It checks modules only \
                         while its window is open, so it is probably closed: tell the user the \
                         module is saved but unchecked. set_wallpaper can still apply it, and \
                         the App checks it when it opens.";

type Statuses = HashMap<String, ModuleStatus>;

impl AppApplication {
    /// Starts appending `wallpaper.modules.updated {ids}` for changes under
    /// the user module folder. The callback holds no application handle, so
    /// the watcher never keeps its owner alive.
    pub(in crate::gateway::application) async fn watch_wallpaper_modules(&self) {
        let storage = self.storage.clone();
        let subscribers = self.subscribers.clone();
        let dependencies = self.dependencies.clone();
        let _ = self
            .wallpapers
            .watch_modules(Arc::new(move |ids| {
                let (storage, subscribers) = (storage.clone(), subscribers.clone());
                let now = dependencies.identity_clock.now_iso();
                Box::pin(async move {
                    let payload = Map::from_iter([("ids".to_owned(), json!(ids))]);
                    let _ = storage
                        .execute(move |db| {
                            events::append(db, &subscribers, MODULES_UPDATED, None, payload, &now)
                                .map(|_| ())
                        })
                        .await;
                })
            }))
            .await;
    }

    /// The user modules as their files are now, with the stored checks.
    async fn user_modules(&self) -> Result<(Vec<UserModule>, Statuses), GatewayApplicationError> {
        let modules = self.wallpapers.user_modules().await?;
        let statuses = self.storage.execute(|db| module_status::all(db)).await;
        Ok((modules, statuses.map_err(app_error)?))
    }

    /// Built-ins, then user modules with their status; for an agent, each
    /// usable module also says how it can be used.
    pub(super) async fn module_entries(
        &self,
        agent: bool,
    ) -> Result<Vec<Value>, GatewayApplicationError> {
        let (modules, statuses) = self.user_modules().await?;
        let builtin = WallpaperModules::builtin();
        let mut entries = builtin.builtin_entries(agent);
        entries.extend(modules.iter().map(|user| {
            let mut entry = user.entry(statuses.get(&user.id));
            if let (true, Ok(module)) = (agent, &user.module) {
                describe_for_agent(&mut entry, module);
            }
            entry
        }));
        Ok(entries)
    }

    /// The modules an agent may choose: built-ins and every user module that
    /// can be drawn; the others are refused with why.
    pub(super) async fn selectable_modules(
        &self,
    ) -> Result<WallpaperModules, GatewayApplicationError> {
        let (modules, statuses) = self.user_modules().await?;
        let mut usable = Vec::new();
        let mut unusable = Vec::new();
        for user in modules {
            match (user.failure(statuses.get(&user.id)), user.module) {
                (None, Ok(module)) => usable.push(module),
                (failure, _) => unusable.push((user.id, failure.unwrap_or_default())),
            }
        }
        Ok(WallpaperModules::builtin().with(usable).except(unusable))
    }

    /// A file of a valid user module: `file` picks it from the module.
    async fn module_file<T>(
        &self,
        id: String,
        file: impl FnOnce(&UserModule) -> Option<T>,
        missing: &str,
    ) -> Result<(T, String), GatewayApplicationError> {
        let module = self.wallpapers.user_module(id.clone()).await?;
        let module = module.ok_or_else(module_not_found)?;
        if let Err(reason) = &module.module {
            return Err(invalid_module(&id, reason));
        }
        match file(&module) {
            Some(found) => Ok((found, module.revision)),
            None => Err(GatewayApplicationError::public(
                404,
                "wallpaper_module_file_not_found",
                format!("Wallpaper module {id} has no {missing}."),
            )),
        }
    }

    pub(super) async fn module_shader(
        &self,
        id: String,
    ) -> Result<AppWallpaperModuleShader, GatewayApplicationError> {
        let shader = |module: &UserModule| module.shader().map(str::to_owned);
        let (text, revision) = self.module_file(id, shader, "shader.frag").await?;
        Ok(AppWallpaperModuleShader { text, revision })
    }

    pub(super) async fn module_overlay(
        &self,
        id: String,
    ) -> Result<AppWallpaperModuleShader, GatewayApplicationError> {
        let overlay = |module: &UserModule| module.overlay().map(str::to_owned);
        let (text, revision) = self.module_file(id, overlay, "overlay.frag").await?;
        Ok(AppWallpaperModuleShader { text, revision })
    }

    pub(super) async fn module_image(
        &self,
        id: String,
    ) -> Result<AppWallpaperFile, GatewayApplicationError> {
        let image = |module: &UserModule| module.image().cloned();
        let (image, revision) = self.module_file(id, image, "default image").await?;
        Ok(AppWallpaperFile {
            mime_type: image.mime_type.to_owned(),
            etag: format!("\"{revision}\""),
            bytes: image.bytes.into(),
        })
    }

    pub(super) async fn report_module_status(
        &self,
        id: String,
        report: AppWallpaperModuleStatusReport,
    ) -> Result<Value, GatewayApplicationError> {
        if !matches!(report.state.as_str(), "checking" | "ok" | "error") {
            return Err(GatewayApplicationError::public(
                400,
                "wallpaper_module_status_invalid",
                "Status must be {state: \"checking\" | \"ok\" | \"error\", message?, \
                 revision?}.",
            ));
        }
        refuse_builtin(&id)?;
        let module = self.wallpapers.user_module(id.clone()).await?;
        let module = module.ok_or_else(module_not_found)?;
        if report
            .revision
            .is_some_and(|revision| revision != module.revision)
        {
            return Err(GatewayApplicationError::public(
                409,
                "wallpaper_module_changed",
                "The module files changed after that check; check the current files.",
            ));
        }
        let message = report
            .message
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let status = ModuleStatus {
            revision: module.revision.clone(),
            state: report.state,
            message: message.map(|text| text.chars().take(MAX_MESSAGE_CHARS).collect()),
            checked_at: self.dependencies.identity_clock.now_iso(),
        };
        let stored = status.clone();
        self.storage
            .execute(move |db| module_status::put(db, &id, &stored))
            .await
            .map_err(app_error)?;
        Ok(module.status(Some(&status)))
    }

    /// Installs an archive; one whose id is installed already needs
    /// `replace`, and the replaced files stay recoverable.
    pub(super) async fn import_module(
        &self,
        archive: Bytes,
        replace: bool,
    ) -> Result<Value, GatewayApplicationError> {
        let _settings = self.settings_update_lock.lock().await;
        let unique = self.dependencies.identity_clock.new_uuid();
        let module = self
            .wallpapers
            .install_module(archive, unique, replace)
            .await?;
        let statuses = self.storage.execute(|db| module_status::all(db)).await;
        Ok(module.entry(statuses.map_err(app_error)?.get(&module.id)))
    }

    /// Checks and writes an agent's module, then waits up to `wait` for the
    /// App's check of exactly the written files. A module that names a
    /// default image keeps the one the replaced module holds. An installed
    /// module is replaced only at the revision the request names (saving
    /// exactly its current files again changes nothing); the replaced files
    /// and thumbnail stay recoverable.
    pub(in crate::gateway::application) async fn save_module(
        &self,
        request: AppWallpaperModuleSaveRequest,
        wait: Duration,
    ) -> Result<Result<AppWallpaperModuleSaved, AppWallpaperRejection>, GatewayApplicationError>
    {
        let module = {
            let _settings = self.settings_update_lock.lock().await;
            let image = match save::default_image(&request) {
                Some(name) => {
                    let existing = self.wallpapers.existing_image(request.id.clone(), name);
                    existing.await?
                }
                None => FileRead::Missing,
            };
            let unpacked = match save::checked(&request, image) {
                Ok(unpacked) => unpacked,
                Err(rejection) => return Ok(Err(rejection)),
            };
            let installed = self.wallpapers.user_module(request.id.clone()).await?;
            match installed {
                Some(current) if current.revision == unpacked.revision() => current,
                Some(current)
                    if request.replace_revision.as_deref() != Some(current.revision.as_str()) =>
                {
                    return Ok(Err(save::exists(&request.id)));
                }
                _ => {
                    let unique = self.dependencies.identity_clock.new_uuid();
                    self.wallpapers.write_module(unpacked, unique).await?
                }
            }
        };
        let status = self.module_check(&module, wait).await?;
        Ok(Ok(AppWallpaperModuleSaved {
            id: module.id,
            status,
        }))
    }

    /// The App's check of `module`'s revision once reported, or `unknown`
    /// with why after `wait`.
    async fn module_check(
        &self,
        module: &UserModule,
        wait: Duration,
    ) -> Result<Value, GatewayApplicationError> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let id = module.id.clone();
            let stored = self
                .storage
                .execute(move |db| module_status::get(db, &id))
                .await
                .map_err(app_error)?;
            // `checking` is the App's mark before its verdict, not a verdict.
            if let Some(stored) = stored
                .filter(|stored| stored.revision == module.revision && stored.state != "checking")
            {
                return Ok(module.status(Some(&stored)));
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Ok(json!({"state": "unknown", "message": UNCHECKED}));
            }
            tokio::time::sleep(CHECK_POLL.min(deadline - now)).await;
        }
    }

    pub(super) async fn delete_module(&self, id: String) -> Result<(), GatewayApplicationError> {
        refuse_builtin(&id)?;
        let _settings = self.settings_update_lock.lock().await;
        if self.wallpapers.user_module(id.clone()).await?.is_none() {
            return Err(module_not_found());
        }
        let lookup = id.clone();
        let users = self
            .storage
            .execute(move |db| references::module(db, &lookup))
            .await
            .map_err(app_error)?;
        if !users.is_empty() {
            return Err(GatewayApplicationError::public(
                409,
                "wallpaper_module_in_use",
                format!("Wallpaper module is in use by {}.", users.join(", ")),
            ));
        }
        let unique = self.dependencies.identity_clock.new_uuid();
        if !self.wallpapers.remove_module(id.clone(), unique).await? {
            return Err(module_not_found());
        }
        self.storage
            .execute(move |db| module_status::delete(db, &id))
            .await
            .map_err(app_error)
    }
}

/// Built-ins ship with the App: they take no reports and are never deleted.
fn refuse_builtin(id: &str) -> Result<(), GatewayApplicationError> {
    if WallpaperModules::builtin().get(id).is_some() || id == "butler.image" {
        return Err(GatewayApplicationError::public(
            400,
            "wallpaper_module_builtin",
            "Built-in wallpaper modules cannot be changed.",
        ));
    }
    Ok(())
}

fn invalid_module(id: &str, reason: &str) -> GatewayApplicationError {
    GatewayApplicationError::public(
        409,
        "wallpaper_module_invalid",
        format!("Wallpaper module {id} is invalid: {reason}."),
    )
}
