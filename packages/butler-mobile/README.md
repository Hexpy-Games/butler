# Butler mobile

The Butler phone app (Expo, iOS and Android). It has its own install; it is not part of the root workspace.

```bash
cd packages/butler-mobile
bun install
bun run typecheck
bun test src
bun run start
```

## Device builds

EAS builds in the cloud. `EXPO_TOKEN` signs in; iOS signing uses an App Store Connect API key (`EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`, `EXPO_APPLE_TEAM_ID`).

```bash
bun run build:testflight   # iOS build, then upload to TestFlight
bun run build:apk          # Android APK to install directly
```
