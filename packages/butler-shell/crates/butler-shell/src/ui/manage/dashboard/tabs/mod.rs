//! The dashboard's materials, results, history and statistics panels
//! (`management/ProjectMaterialsPanel.tsx`, `ProjectResultsPanel.tsx`, `ProjectHistoryPanel.tsx`,
//! `ProjectStatisticsPanel.tsx` and the statistics groups under it). M7 rebuilds a panel on
//! React's keys (`project:ledgerRevision:preferencesRevision`, `project:publicRevision`).
mod copy;
mod docs;
mod format;
mod history;
mod materials;
mod results;
mod stats;

pub(crate) use self::history::HistoryPanel;
pub(crate) use self::materials::MaterialsPanel;
pub(crate) use self::results::ResultsPanel;
pub(crate) use self::stats::StatisticsPanel;
