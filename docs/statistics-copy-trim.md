# Statistics activity copy refinement

Accepted scope (2026-09-10): retain the activity section's explanation and color
swatches/count labels, but remove the repeated legend heading and counting example.
Remove the tool-call exclusion sentence from the adjacent Work activity section.
Apply the same change in Korean and English. Do not change aggregation, selection,
date range, accessibility labels or the unrelated statistics sections.

Tasks: (1) remove unused product copy and make the DS legend heading optional;
(2) verify heading-free swatches, unchanged selection and responsive rendering;
(3) review the diff against this scope and record the result.

Review: this replaces the earlier request for a visible counting example. The
section explanation already defines a day and activity; counting implementation
details need not be repeated inside the visualization.

Completed: redundant Korean/English keys removed from the central copy contract;
the existing DS legend accepts no title without rendering empty heading spacing.
Four component tests passed. The production-data read-only browser smoke passed
at 320/375/390/430/1440px and for 7/30/90-day selections. Desktop dark and mobile
light screenshots were visually inspected: swatches and date drilldown remain,
and all three requested redundant text elements are absent. No aggregation or
runtime deployment/restart changes are included.
