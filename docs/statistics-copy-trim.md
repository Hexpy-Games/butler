# Statistics activity copy refinement

Accepted scope (2026-09-10, revision 2): remove both activity section descriptions
and the entire heatmap legend, in addition to the earlier repeated heading and
counting example removal. Keep section titles, data, date range and date drilldown.
Apply the same change in Korean and English. Do not change aggregation, selection,
date range, accessibility labels or the unrelated statistics sections.

Tasks: (1) omit section descriptions and the DS legend, remove unused product copy;
(2) verify absent descriptions/legend, unchanged selection and responsive rendering;
(3) review the diff against this scope and record the result.

Review: revision 2 supersedes the earlier decision to retain section explanations
and color swatches. The DS legend remains available to other consumers; this
dashboard omits it. Date cells retain their accessible labels and tooltips.

Revision 1 completed: redundant Korean/English keys removed from the central copy contract;
the existing DS legend accepts no title without rendering empty heading spacing.
Four component tests passed. The production-data read-only browser smoke passed
at 320/375/390/430/1440px and for 7/30/90-day selections. Desktop dark and mobile
light screenshots were visually inspected: swatches and date drilldown remain,
and all three requested redundant text elements are absent. No aggregation or
runtime deployment/restart changes are included.

Revision 2 completed: both section descriptions and the entire heatmap legend
are omitted. Unused Korean/English copy keys were deleted. Four DS tests and the
responsive browser smoke passed again, including 7/30/90-day switching, five
viewport widths and date selection. The rendered desktop view was inspected;
section headings now lead directly into the data panels. Deployment remains out
of this copy-only change.
