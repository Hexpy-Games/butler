# TitlebarShell

## What is this component
A compact titlebar composition for shell previews.

## When to use this component
Use it for titlebar-like app chrome and viewer fixtures.

## Where to use this component
Use it inside `ChromeFrame` or product titlebar presenters.

## Why to use this component
It standardizes app identity, subtitle, and trailing controls.

## How to use this component
Pass title, optional subtitle, leading, trailing nodes, and optional
windowControls for App-owned platform controls that must anchor to the window
edge instead of joining normal toolbar flow.

## Who can use this component
Shell components and DS fixtures.

## Best practice
Keep window drag, IPC, and routing behavior outside this block.

## Wrong use cases
Do not use it for page headers. Use `DashboardHeader` or `SettingsHeader`.

## Auto-sized leading control
`leadingSize="auto"` lets `leading` hold a control at its own size (the
standalone Browser's conversation button) instead of the title-line square.
The control is pulled back by its inner inset so its label starts where the
title would; the collapsed-sidebar inset on the bar is unchanged.

## Tags
titlebar, shell, chrome
