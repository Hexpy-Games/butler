# LiveTabList

A controlled list of live tab previews. The first three cards remain full size;
folded overflow becomes one favicon row with a measured +N remainder. Expanding
shows every card and preserves keyboard focus on the same toggle.

Pass `tabs`, `expanded`, `onExpandedChange` and localized `labels.more`,
`labels.overflow`, `labels.less`. `limit` defaults to 3. The container owns frame
subscriptions and should subscribe only to visible cards. Favicon appearance
comes from TabStrip's TabFavicon. Width measurements run on resize or input
changes, with no polling. Keep ancestors unclipped with focus ring room.
