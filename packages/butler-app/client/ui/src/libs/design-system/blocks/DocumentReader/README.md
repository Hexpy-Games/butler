# DocumentReader

Read-only document and artifact layout: stable header, scrollable facts/body,
and a visible footer action. Used by project document dialogs for specifications,
reports and artifacts. Compose inside DialogContent; the caller supplies an
accessible DialogTitle and description in `header`.

Pass localized, already formatted `facts`, body, optional disclosure `details`,
read-only `hint` and `action`. Missing facts should be omitted rather than inferred.
The component owns spacing and responsive layout, never fetching or routing.

Keep metadata concise and technical identifiers in a collapsed DisclosureRow.
The body text lines up with the header. The scroll frame keeps its ring room
before the reader inset, so a plain DisclosureRow's hover fill (it bleeds like
`Clickable bleed="inline"`) and its focus ring stay inside the clip.
Do not use this for an editor or a resource list; use form controls or DocumentTile.

Tags: document, artifact, reader, metadata, dialog, responsive
