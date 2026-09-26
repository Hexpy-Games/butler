//! Path-free visual derivative sanitization and source-record verification.

mod contracts;
mod manifest;
mod sanitize;

pub(crate) use crate::models::{
    ImageCapabilityEvidence, ImageCarrierTuple, VisualImageAdmissionResult,
    admit_visual_image_request, assert_visual_carrier_matches_catalog,
    image_admission_for_catalog_entry,
};
#[cfg(test)]
pub(crate) use contracts::SanitizedImage;
pub(crate) use contracts::{
    ImageSanitizerInput, ImageSanitizerLimits, ImageSourceRecord, VisualAttachmentManifest,
};
pub(crate) use manifest::verify_visual_manifest_source;
pub(crate) use sanitize::sanitize_image;

#[cfg(test)]
mod tests;
