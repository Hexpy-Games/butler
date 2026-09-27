//! Path-free visual derivative sanitization and source-record verification.

mod contracts;
mod manifest;
mod sanitize;

pub use butler_models::models::ImageCapabilityEvidence;
pub use butler_models::models::ImageCarrierTuple;
pub use butler_models::models::VisualImageAdmissionResult;
pub use butler_models::models::admit_visual_image_request;
pub use butler_models::models::assert_visual_carrier_matches_catalog;
pub use butler_models::models::image_admission_for_catalog_entry;
#[cfg(any(test, feature = "test-support"))]
pub(crate) use contracts::SanitizedImage;
pub use contracts::{
    ImageSanitizerInput, ImageSanitizerLimits, ImageSourceRecord, VisualAttachmentManifest,
};
pub use manifest::verify_visual_manifest_source;
pub use sanitize::sanitize_image;

#[cfg(test)]
mod tests;
