//! Drop zones for drag-and-drop lists (`lib/dropZones.ts`, DS spec M5 Drag Feedback). Hit
//! testing uses layout boxes, which the drop feedback (translate, scale, rings) never changes,
//! so feedback cannot move the zones under the pointer. Zone boundaries and the current row
//! have hysteresis, and entering `Combine` (group, drop inside) waits for a short dwell.
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropZone {
    Before,
    /// Group, or drop inside.
    Combine,
    After,
}

/// Share of the row height given to each edge (insert) zone when it can combine.
pub const EDGE: f32 = 0.25; // DS: dropZones.ts:38
/// Px the pointer must travel past a boundary before the zone flips.
pub const HYSTERESIS: f32 = 4.; // DS: dropZones.ts:40
/// How long the pointer rests in a combine zone before it becomes the drop.
pub const COMBINE_DWELL: Duration = Duration::from_millis(150); // DS: dropZones.ts:42
/// Px between rows (gaps) that still resolve to the nearest row.
const NEAREST_ROW_SLACK: f32 = 8.; // DS: dropZones.ts:44

/// The header box of a row in layout (untransformed) position, in window px.
#[derive(Clone, Copy, Debug)]
pub struct DropZoneBox {
    pub top: f32,
    pub height: f32,
}

/// What a row accepts.
#[derive(Clone, Copy, Debug)]
pub struct DropZoneRules {
    /// The row accepts a drop onto it (group, drop inside).
    pub combine: bool,
    /// The row has an after zone (false for an expanded folder).
    pub after: bool,
}

#[derive(Clone, Debug)]
pub struct DropZoneCandidate<K> {
    pub key: K,
    pub bounds: DropZoneBox,
    pub rules: DropZoneRules,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DropZoneHit<K> {
    pub key: K,
    pub zone: DropZone,
}

/// The zones of a row from its top edge, each ending at a share of the row height.
fn zones_for(rules: DropZoneRules) -> Vec<(DropZone, f32)> {
    match (rules.combine, rules.after) {
        (true, true) => vec![
            (DropZone::Before, EDGE),
            (DropZone::Combine, 1. - EDGE),
            (DropZone::After, f32::INFINITY),
        ],
        (true, false) => vec![(DropZone::Before, EDGE), (DropZone::Combine, f32::INFINITY)],
        (false, true) => vec![(DropZone::Before, 0.5), (DropZone::After, f32::INFINITY)],
        (false, false) => vec![(DropZone::Before, f32::INFINITY)],
    }
}

/// The zone under `y` for one row. A boundary next to the `current` zone moves `hysteresis` px
/// away from it, so jitter at a boundary keeps the zone.
pub fn resolve_drop_zone(
    y: f32,
    bounds: DropZoneBox,
    rules: DropZoneRules,
    current: Option<DropZone>,
    hysteresis: f32,
) -> DropZone {
    let offset = y - bounds.top;
    let zones = zones_for(rules);
    for pair in zones.windows(2) {
        let (zone, end) = pair[0];
        let mut boundary = end * bounds.height;
        if current == Some(zone) {
            boundary += hysteresis;
        } else if current == Some(pair[1].0) {
            boundary -= hysteresis;
        }
        if offset < boundary {
            return zone;
        }
    }
    zones.last().map_or(DropZone::Before, |(zone, _)| *zone)
}

/// The row under `y`: the current row while the pointer is within its box plus hysteresis,
/// else the nearest row within the slack.
fn row_at<'a, K: PartialEq>(
    y: f32,
    rows: &'a [DropZoneCandidate<K>],
    current: Option<&DropZoneHit<K>>,
) -> Option<&'a DropZoneCandidate<K>> {
    let kept = current.and_then(|hit| rows.iter().find(|row| row.key == hit.key));
    if let Some(row) = kept
        && y >= row.bounds.top - HYSTERESIS
        && y <= row.bounds.top + row.bounds.height + HYSTERESIS
    {
        return Some(row);
    }
    let away = |row: &DropZoneCandidate<K>| {
        let (top, bottom) = (row.bounds.top, row.bounds.top + row.bounds.height);
        if y < top {
            top - y
        } else if y >= bottom {
            y - bottom
        } else {
            0.
        }
    };
    rows.iter()
        .min_by(|a, b| away(a).total_cmp(&away(b)))
        .filter(|row| away(row) <= NEAREST_ROW_SLACK)
}

struct Pending<K> {
    key: K,
    since: Instant,
}

/// Resolves the pointer against the rows with hysteresis and the combine dwell
/// (`createDropZoneTracker`). Feed it every drag move with [`Self::update`]; while
/// [`Self::waiting`] holds, call [`Self::poll`] each frame, as the React timer does.
pub struct DropZoneTracker<K> {
    dwell: Duration,
    current: Option<DropZoneHit<K>>,
    pending: Option<Pending<K>>,
    last: Option<(f32, Vec<DropZoneCandidate<K>>)>,
}

impl<K> Default for DropZoneTracker<K> {
    fn default() -> Self {
        Self {
            dwell: COMBINE_DWELL,
            current: None,
            pending: None,
            last: None,
        }
    }
}

impl<K: Clone + PartialEq> DropZoneTracker<K> {
    /// A tracker whose combine zone waits `dwell` (default [`COMBINE_DWELL`]).
    pub fn with_dwell(dwell: Duration) -> Self {
        Self {
            dwell,
            ..Self::default()
        }
    }

    pub fn current(&self) -> Option<&DropZoneHit<K>> {
        self.current.as_ref()
    }

    /// A combine zone is waiting out its dwell.
    pub fn waiting(&self) -> bool {
        self.pending.is_some()
    }

    pub fn reset(&mut self) {
        self.pending = None;
        self.current = None;
        self.last = None;
    }

    /// Resolves `y` (window px) against `rows` at `now`; returns the hit now in effect.
    pub fn update(
        &mut self,
        y: f32,
        rows: Vec<DropZoneCandidate<K>>,
        now: Instant,
    ) -> Option<DropZoneHit<K>> {
        let hit = self.resolve(y, &rows, now);
        self.last = Some((y, rows));
        hit
    }

    /// Re-resolves the last pointer position at `now`, so a dwell commits without a move.
    pub fn poll(&mut self, now: Instant) -> Option<DropZoneHit<K>> {
        let Some((y, rows)) = self.last.take() else {
            return self.current.clone();
        };
        let hit = self.resolve(y, &rows, now);
        self.last = Some((y, rows));
        hit
    }

    fn resolve(
        &mut self,
        y: f32,
        rows: &[DropZoneCandidate<K>],
        now: Instant,
    ) -> Option<DropZoneHit<K>> {
        let Some(row) = row_at(y, rows, self.current.as_ref()) else {
            self.pending = None;
            self.current = None;
            return None;
        };
        let same = self.current.as_ref().filter(|hit| hit.key == row.key);
        let zone = resolve_drop_zone(
            y,
            row.bounds,
            row.rules,
            same.map(|hit| hit.zone),
            HYSTERESIS,
        );
        if zone != DropZone::Combine || same.is_some_and(|hit| hit.zone == DropZone::Combine) {
            self.pending = None;
            return self.commit(row.key.clone(), zone);
        }
        let waiting = self
            .pending
            .as_ref()
            .filter(|pending| pending.key == row.key);
        let since = waiting.map_or(now, |pending| pending.since);
        if waiting.is_none() {
            self.pending = Some(Pending {
                key: row.key.clone(),
                since: now,
            });
        }
        if now.duration_since(since) >= self.dwell {
            self.pending = None;
            return self.commit(row.key.clone(), zone);
        }
        self.current.clone()
    }

    fn commit(&mut self, key: K, zone: DropZone) -> Option<DropZoneHit<K>> {
        let hit = DropZoneHit { key, zone };
        if self.current.as_ref() != Some(&hit) {
            self.current = Some(hit);
        }
        self.current.clone()
    }
}
