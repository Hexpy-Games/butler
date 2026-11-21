# QrCode

## What is this component
A scannable QR code with dark modules on a white tile and a standard 4-module quiet zone.

## When to use this component
Use it for a link or code another device scans with its camera.

## Where to use this component
Device pairing and cross-device links.

## Why to use this component
The code stays dark on white in every theme so cameras can read it.

## How to use this component
`<QrCode value="butler://pair?v=1&a=http%3A%2F%2F192.168.1.20%3A19765&c=12345678" label="Pairing QR code" />`

## Who can use this component
Product components that present a link or code for another device to scan.

## Best practice
Show the same information as text beside it (the code), so people without a camera can still use it.

## Wrong use cases
Do not use it for decoration or for links people can click. Use a link or `CopyButton`.

## Tags
qr, scan, pairing, link
