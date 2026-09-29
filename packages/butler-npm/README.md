# @hexpygames/butler

Installs the [Butler](https://github.com/Hexpy-Games/butler) agent and its `butler` command.

```sh
npx @hexpygames/butler install
```

This runs the same installer as
`curl -fsSL https://github.com/Hexpy-Games/butler/releases/latest/download/install.sh | sh`
for the release matching this package's version. Flags: `--version X.Y.Z`,
`--no-start`, `--modify-path`. macOS arm64 and Linux x64/arm64 only for now.

Any other arguments go to the installed `butler`:

```sh
npx @hexpygames/butler status
```

The package has no dependencies and downloads nothing except the verified agent archive from GitHub Releases.
