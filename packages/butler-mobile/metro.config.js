const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../butler-protocol"), path.resolve(__dirname, "../butler-i18n")];
module.exports = config;
