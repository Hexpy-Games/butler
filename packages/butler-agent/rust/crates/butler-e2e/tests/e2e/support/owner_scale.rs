//! Post-reclaim owner data (#1298): ~1 GB BTCC and ~1.2 GB App DB.
//! Only payload widths change after model-round reclaim; record counts stay fixed.

pub(super) const BTCC_PAYLOAD_BYTES: [usize; 7] = [1_600, 1_800, 2_000, 2_200, 1_800, 2_000, 2_200];
// App seeds hex-encode each blob, producing twice this many payload characters.
pub(super) const APP_BLOB_BYTES: usize = 2_600;
pub(super) const BTCC_DATABASE_BYTES: std::ops::RangeInclusive<u64> = 950_000_000..=1_100_000_000;
pub(super) const APP_DATABASE_BYTES: std::ops::RangeInclusive<u64> = 1_150_000_000..=1_300_000_000;
