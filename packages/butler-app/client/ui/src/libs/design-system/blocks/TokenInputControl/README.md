# TokenInputControl

## What is this component
A text input with token preview chips.

## When to use this component
Use it when a setting accepts comma-separated or parsed tokens.

## Where to use this component
Use it in settings forms and filter configuration.

## Why to use this component
It separates token display from parsing and persistence.

## How to use this component
Pass input value, change handler, and parsed token strings.

## Who can use this component
Settings containers that own token parsing.

## Best practice
Parse, validate, and persist tokens outside the block.

## Wrong use cases
Do not use it for file attachments. Use `AttachmentList`.

## Tags
settings, tokens, input, chips
