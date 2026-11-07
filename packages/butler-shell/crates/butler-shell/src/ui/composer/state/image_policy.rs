//! `composerImagePolicy.ts`: which attached images the selected model takes.
pub(crate) use crate::ui::i18n::composer::labels::image_refusal_label;
use std::collections::HashMap;

use super::ComposerAttachment;
use crate::ui::composer::menus::ModelChoice;
use crate::ui::source::wire::MessageFileKind;

/// The gateway's image kinds (message_file_store `kind`): other image/* files are ordinary files.
const GATEWAY_IMAGE_MIME_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMAGE_EXTENSION_MIME: [(&str, &str); 5] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
];

/// GIF is re-encoded as PNG by the gateway before admission.
fn derivative_mime(mime: &str) -> &str {
    if mime == "image/gif" {
        "image/png"
    } else {
        mime
    }
}

/// Why the selected model takes no images: declared text-only, capability unknown, or unknown
/// on a user-registered local model, where Settings can declare it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ModelImageBlock {
    Model,
    Unknown,
    Undeclared,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ComposerImagePolicy {
    pub(crate) accepts: bool,
    pub(crate) blocked_by: Option<ModelImageBlock>,
    pub(crate) mime_types: Vec<String>,
    pub(crate) max_bytes: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImageRefusal {
    Model,
    Unknown,
    Undeclared,
    Type,
    Size,
}

impl From<ModelImageBlock> for ImageRefusal {
    fn from(block: ModelImageBlock) -> Self {
        match block {
            ModelImageBlock::Model => Self::Model,
            ModelImageBlock::Unknown => Self::Unknown,
            ModelImageBlock::Undeclared => Self::Undeclared,
        }
    }
}

/// `AttachmentPickerKind`
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum AttachmentPickerKind {
    #[default]
    Files,
    Images,
}

/// `AttachmentPickerFilter`
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AttachmentPickerFilter {
    AllFiles,
    Images { accept: String },
}

/// `FileLike`
pub(crate) struct FileLike<'a> {
    pub(crate) name: &'a str,
    pub(crate) mime_type: &'a str,
    pub(crate) size: Option<i64>,
}

/// Only an explicit `supported` allows images. `unsupported` blocks them, and unknown or
/// absent metadata (or no resolved model) blocks them too, matching the gateway, which rejects
/// images at admission when capability is unknown.
pub(crate) fn composer_image_policy(model: Option<&ModelChoice>) -> ComposerImagePolicy {
    let Some(model) = model.filter(|m| m.image_input_support.as_deref() == Some("supported"))
    else {
        return ComposerImagePolicy {
            accepts: false,
            blocked_by: Some(model_image_block(model)),
            mime_types: Vec::new(),
            max_bytes: None,
        };
    };
    let catalog_types: Option<Vec<String>> = model
        .image_accepted_mime_types
        .as_ref()
        .filter(|types| !types.is_empty())
        .map(|types| types.iter().map(|t| t.to_lowercase()).collect());
    let mime_types = GATEWAY_IMAGE_MIME_TYPES
        .iter()
        .filter(|mime| {
            catalog_types
                .as_ref()
                .is_none_or(|types| types.iter().any(|t| t == derivative_mime(mime)))
        })
        .map(|mime| (*mime).to_owned())
        .collect();
    ComposerImagePolicy {
        accepts: true,
        blocked_by: None,
        mime_types,
        max_bytes: model.image_max_inline_bytes.filter(|bytes| *bytes > 0),
    }
}

fn model_image_block(model: Option<&ModelChoice>) -> ModelImageBlock {
    match model {
        Some(m) if m.image_input_support.as_deref() == Some("unsupported") => {
            ModelImageBlock::Model
        }
        Some(m) if m.provider_id.as_ref() == "local" => ModelImageBlock::Undeclared,
        _ => ModelImageBlock::Unknown,
    }
}

fn image_mime(file: &FileLike) -> Option<String> {
    let kind = file.mime_type.to_lowercase();
    if !kind.is_empty() {
        return GATEWAY_IMAGE_MIME_TYPES
            .contains(&kind.as_str())
            .then_some(kind);
    }
    let name = file.name.to_lowercase();
    let extension = name.rsplit('.').next().unwrap_or_default();
    IMAGE_EXTENSION_MIME
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| (*mime).to_owned())
}

pub(crate) fn image_refusal(file: &FileLike, policy: &ComposerImagePolicy) -> Option<ImageRefusal> {
    let mime = image_mime(file)?;
    if !policy.accepts {
        return Some(policy.blocked_by.map_or(ImageRefusal::Model, Into::into));
    }
    if !policy.mime_types.contains(&mime) {
        return Some(ImageRefusal::Type);
    }
    if policy
        .max_bytes
        .is_some_and(|max| file.size.unwrap_or(0) > max)
    {
        return Some(ImageRefusal::Size);
    }
    None
}

pub(crate) fn attachment_picker_filter(
    kind: AttachmentPickerKind,
    policy: &ComposerImagePolicy,
) -> AttachmentPickerFilter {
    if policy.accepts && kind == AttachmentPickerKind::Images {
        AttachmentPickerFilter::Images {
            accept: policy.mime_types.join(","),
        }
    } else {
        AttachmentPickerFilter::AllFiles
    }
}

/// `blockedImageAttachmentIds`: attached images the current model refuses (kept, but send is
/// blocked).
pub(crate) fn blocked_image_attachment_ids(
    attachments: &[ComposerAttachment],
    policy: &ComposerImagePolicy,
) -> HashMap<String, ImageRefusal> {
    let mut blocked = HashMap::new();
    for attachment in attachments {
        if attachment.kind != MessageFileKind::Image {
            continue;
        }
        let file = FileLike {
            name: &attachment.file.safe_name,
            mime_type: &attachment.file.mime_type,
            size: Some(attachment.file.size_bytes),
        };
        if let Some(refusal) = image_refusal(&file, policy) {
            blocked.insert(attachment.id.clone(), refusal);
        }
    }
    blocked
}
