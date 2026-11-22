const path = require("path");
const upstream = require("@expo/metro-config/babel-transformer");
// pdf.js ships to the WebView as text: its build files become string modules instead of app code.
// Non-ASCII characters are written as \u escapes so Hermes can store the text as one-byte ASCII.
const pdfjs = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "legacy/build") + path.sep;
const ascii = (src) => src.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
module.exports = {
  ...upstream,
  transform(args) {
    const file = path.resolve(args.options.projectRoot, args.filename);
    return upstream.transform(file.startsWith(pdfjs) ? { ...args, src: `module.exports = ${JSON.stringify(ascii(args.src))};` } : args);
  },
};
