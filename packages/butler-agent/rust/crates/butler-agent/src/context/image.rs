//! Path-free visual derivative sanitization and source-record verification.

mod contracts;
mod manifest;
mod sanitize;

pub(crate) use butler_models::models::ImageCapabilityEvidence;
pub(crate) use butler_models::models::ImageCarrierTuple;
pub(crate) use butler_models::models::VisualImageAdmissionResult;
pub(crate) use butler_models::models::admit_visual_image_request;
pub(crate) use butler_models::models::assert_visual_carrier_matches_catalog;
pub(crate) use butler_models::models::image_admission_for_catalog_entry;
#[cfg(test)]
pub(crate) use contracts::SanitizedImage;
pub(crate) use contracts::{
    ImageSanitizerInput, ImageSanitizerLimits, ImageSourceRecord, VisualAttachmentManifest,
};
pub(crate) use manifest::verify_visual_manifest_source;
pub(crate) use sanitize::sanitize_image;

#[cfg(test)]
mod tests;
