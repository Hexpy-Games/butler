//! Path-free visual derivative sanitization and source-record verification.

mod contracts;
mod manifest;
mod sanitize;

pub use butler_models::models::{
    ImageCapabilityEvidence, ImageCarrierTuple, VisualImageAdmissionResult,
    admit_visual_image_request, assert_visual_carrier_matches_catalog,
    image_admission_for_catalog_entry,
};
pub use contracts::{
    ImageSanitizerInput, ImageSanitizerLimits, ImageSourceRecord, VisualAttachmentManifest,
};
pub use manifest::verify_visual_manifest_source;
pub use sanitize::sanitize_image;
