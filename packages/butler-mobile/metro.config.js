const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../butler-protocol"), path.resolve(__dirname, "../butler-i18n"),
  path.resolve(__dirname, "../butler-app/client/ui/src/libs/design-system/components/ProviderLogo"),
  path.resolve(__dirname, "../butler-app/client/ui/src/libs/design-system/blocks/UsageBars"),
  path.resolve(__dirname, "../butler-app/client/ui/src/components/usage"),
  path.resolve(__dirname, "../butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark"),
];
module.exports = config;
