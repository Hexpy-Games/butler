//! Private, transient HTML sources avoid Chromium's navigation URL length limit.
use gpui::{AsyncApp, BackgroundExecutor};
use std::path::PathBuf;

pub(crate) struct HtmlSource {
    directory: PathBuf,
    url: String,
    executor: BackgroundExecutor,
}

impl HtmlSource {
    pub(crate) async fn new(html: String, cx: &AsyncApp) -> Option<Self> {
        let executor = cx.background_executor().clone();
        let directory = executor
            .spawn(async move {
                let directory =
                    std::env::temp_dir().join(format!("butler-html-{}", uuid::Uuid::new_v4()));
                butler_platform::secure_fs::create_private_dir(&directory).ok()?;
                if std::fs::write(directory.join("index.html"), html).is_err() {
                    let _ = butler_platform::secure_fs::remove_tree(&directory);
                    return None;
                }
                Some(directory)
            })
            .await?;
        let url = url::Url::from_file_path(directory.join("index.html"))
            .ok()?
            .to_string();
        Some(Self {
            directory,
            url,
            executor,
        })
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }
}

impl Drop for HtmlSource {
    fn drop(&mut self) {
        let directory = self.directory.clone();
        self.executor
            .spawn(async move {
                let _ = butler_platform::secure_fs::remove_tree(&directory);
            })
            .detach();
    }
}
