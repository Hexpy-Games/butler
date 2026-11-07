//! `messageImages` and `workingFiles`: the pictures the viewer steps through and the file
//! shapes the rows share. Which message file a Markdown image names is `message_markdown`'s.
use std::collections::BTreeSet;

use crate::ui::chat::message_markdown::{file_id_of, markdown_image_file, markdown_images};
use crate::ui::shell::image_viewer::ViewerEntry;
use crate::ui::shell::image_viewer::loader::PictureId;
use crate::ui::source::wire::{
    ChangedFileDetail, MessageFileKind, MessageFileRef, MessageRecord, SessionArtifactSummary,
};

/// The pictures of one message in reading order, with the key each opens by.
pub(super) struct ViewerSet {
    pub(super) keys: Vec<String>,
    pub(super) images: Vec<ViewerEntry>,
}

impl ViewerSet {
    /// `messageViewerImages`: the images in the text, then the artifacts' and attachments'
    /// pictures; each file once.
    pub(super) fn of(message: &MessageRecord) -> Self {
        let attachments = message.attachments.as_deref().unwrap_or_default();
        let artifacts = message.artifacts.as_deref().unwrap_or_default();
        let mut set = Self {
            keys: Vec::new(),
            images: Vec::new(),
        };
        for (src, alt) in markdown_images(&message.text) {
            if let Some(url) = markdown_image_file(&src, attachments) {
                set.add(&url, alt);
            }
        }
        for artifact in artifacts.iter().filter(|a| a.kind == "image") {
            if let Some(url) = &artifact.url {
                set.add(url, artifact.title.clone());
            }
        }
        for file in attachments
            .iter()
            .filter(|f| f.kind == MessageFileKind::Image)
        {
            set.add(&file.url, file.safe_name.clone());
        }
        set
    }

    fn add(&mut self, url: &str, name: String) {
        let Some(file_id) = file_id_of(url) else {
            return;
        };
        if self.keys.iter().any(|key| key == url) {
            return;
        }
        self.keys.push(url.to_owned());
        self.images
            .push(ViewerEntry::new(PictureId::File(file_id.to_owned()), name));
    }

    pub(super) fn index_of(&self, url: &str) -> Option<usize> {
        self.keys.iter().position(|key| key == url)
    }
}

/// `isLegacyFileMessage`: messages stored before files carried their workspace label.
pub(super) fn is_legacy(attachments: &[MessageFileRef]) -> bool {
    attachments.iter().all(|file| file.source_label.is_none())
}

/// A stored message file or an artifact summary, as the rows read it (`fileArtifact`).
pub(super) struct Artifact {
    pub(super) file_id: Option<String>,
    pub(super) title: String,
    pub(super) is_image: bool,
    pub(super) path_label: Option<String>,
    pub(super) url: Option<String>,
    pub(super) size_bytes: Option<i64>,
    pub(super) deliverable: bool,
}

impl Artifact {
    pub(super) fn of_summary(artifact: &SessionArtifactSummary) -> Self {
        Self {
            file_id: artifact.file_id.clone(),
            title: artifact.title.clone(),
            is_image: artifact.kind == "image",
            path_label: artifact.safe_path_label.clone(),
            url: artifact.url.clone().filter(|url| !url.is_empty()),
            size_bytes: artifact.size_bytes,
            deliverable: artifact.deliverable == Some(true),
        }
    }

    pub(super) fn of_file(file: &MessageFileRef) -> Self {
        Self {
            file_id: Some(file.file_id.clone()),
            title: file.safe_name.clone(),
            is_image: file.kind == MessageFileKind::Image,
            path_label: Some(file.safe_name.clone()),
            url: Some(file.url.clone()).filter(|url| !url.is_empty()),
            size_bytes: Some(file.size_bytes),
            deliverable: file.deliverable == Some(true),
        }
    }

    /// The name a saved copy keeps: its own path label, else the title.
    pub(super) fn file_name(&self) -> String {
        self.path_label
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| self.title.clone())
    }
}

/// `formatArtifactSize` (and `formatFileSize` with `gigabytes`).
pub(super) fn format_size(bytes: i64, gigabytes: bool) -> String {
    let size = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if size < 1024. * 1024. {
        format!("{:.1} KB", size / 1024.)
    } else if !gigabytes || size < 1024f64.powi(3) {
        format!("{:.1} MB", size / (1024. * 1024.))
    } else {
        format!("{:.1} GB", size / 1024f64.powi(3))
    }
}

/// One row of the changed-files block: a diff (with its stored copy) or a new file.
pub(super) struct WorkingRow<'a> {
    pub(super) change: Option<&'a ChangedFileDetail>,
    pub(super) file: Option<&'a MessageFileRef>,
}

/// `workingFileRows`: diff rows first (paired with their stored copy by `file_id`), then the
/// files the turn made that are neither delivered, paired with a diff, nor shown inline.
pub(super) fn working_file_rows<'a>(
    changes: &'a [ChangedFileDetail],
    attachments: &'a [MessageFileRef],
    inline: impl FnOnce() -> BTreeSet<String>,
) -> Vec<WorkingRow<'a>> {
    let mut rows: Vec<WorkingRow<'a>> = changes
        .iter()
        .map(|change| WorkingRow {
            change: Some(change),
            file: change
                .file_id
                .as_deref()
                .and_then(|id| attachments.iter().find(|file| file.file_id == id)),
        })
        .collect();
    if is_legacy(attachments) {
        return rows;
    }
    let paired: BTreeSet<&str> = changes
        .iter()
        .filter_map(|change| change.file_id.as_deref())
        .filter(|id| !id.is_empty())
        .collect();
    let generated: Vec<&MessageFileRef> = attachments
        .iter()
        .filter(|file| {
            file.deliverable != Some(true)
                && file.source_label.is_some()
                && !paired.contains(file.file_id.as_str())
        })
        .collect();
    let shown = if generated
        .iter()
        .any(|file| file.kind == MessageFileKind::Image)
    {
        inline()
    } else {
        BTreeSet::new()
    };
    rows.extend(
        generated
            .into_iter()
            .filter(|file| file.kind != MessageFileKind::Image || !shown.contains(&file.url))
            .map(|file| WorkingRow {
                change: None,
                file: Some(file),
            }),
    );
    rows
}
