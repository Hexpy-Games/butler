# SessionRow

## What is this component
A reusable row for conversation or session summaries.

## When to use this component
Use it for recent chats, project sessions, and session search results.

## Where to use this component
Use it in dashboards, sidebars, and command surfaces.

## Why to use this component
It is the sidebar session row (`NavRow` with the session glyph, a truncated
title and hover actions). With a description or meta it switches to the flat
Recent/Running layout: a two-line title clamp over a caption line.

## How to use this component
Pass formatted title, description, metadata, and optional actions.

## Who can use this component
Session containers and project dashboard views.

## Best practice
Keep navigation and session mutations outside this block.

## Wrong use cases
Do not use it for settings navigation. Use `SettingsNav`.

## Tags
session, chat, row, dashboard
