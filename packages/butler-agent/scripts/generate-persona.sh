#!/usr/bin/env bash
# generate-persona.sh — Generate active persona from preset + customization
# Usage: generate-persona.sh <preset> <language> <formality> <tone> <butler_name> <template_dir> <output_path>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || { echo "Butler runtime not available. Re-run install.sh." >&2; exit 1; }

PRESET="$1"
LANG="$2"
FORMALITY="$3"
TONE="${4:-}"
BUTLER_NAME="$5"
TEMPLATE_DIR="$6"
OUTPUT="$7"

LANG_LOWER="$(printf '%s' "$LANG" | tr '[:upper:]' '[:lower:]')"
case "$LANG_LOWER" in
  ko|ko-*|korean|한국어|한국말|한국*)
    TEMPLATE_LOCALE="ko"
    ;;
  *)
    TEMPLATE_LOCALE="en"
    ;;
esac

TEMPLATE="$TEMPLATE_DIR/$PRESET.md"
if [[ ! -f "$TEMPLATE" && -f "$TEMPLATE_DIR/$TEMPLATE_LOCALE/$PRESET.md" ]]; then
  TEMPLATE="$TEMPLATE_DIR/$TEMPLATE_LOCALE/$PRESET.md"
fi
if [[ ! -f "$TEMPLATE" && -f "$TEMPLATE_DIR/en/$PRESET.md" ]]; then
  TEMPLATE="$TEMPLATE_DIR/en/$PRESET.md"
  TEMPLATE_LOCALE="en"
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: Preset template not found: $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"

# Safely escape variables for JS consumption via JSON.stringify
_js_escape() { printf '%s' "$1" | "$BUTLER_BUN" -e "console.log(JSON.stringify(await Bun.stdin.text()))"; }

JS_TEMPLATE=$(_js_escape "$TEMPLATE")
JS_BUTLER_NAME=$(_js_escape "$BUTLER_NAME")
JS_LANG=$(_js_escape "$LANG")
JS_FORMALITY=$(_js_escape "$FORMALITY")
JS_TONE=$(_js_escape "$TONE")
JS_PRESET=$(_js_escape "$PRESET")
JS_TEMPLATE_LOCALE=$(_js_escape "$TEMPLATE_LOCALE")
JS_OUTPUT=$(_js_escape "$OUTPUT")

# Read template, replace {{butler_name}}, then inject language/formality overrides
"$BUTLER_BUN" -e "
import { readFileSync, writeFileSync } from 'fs';

const templatePath = ${JS_TEMPLATE};
const butlerName = ${JS_BUTLER_NAME};
const lang = ${JS_LANG};
const formality = ${JS_FORMALITY};
const tone = ${JS_TONE};
const presetFallback = ${JS_PRESET};
const templateLocale = ${JS_TEMPLATE_LOCALE};
const outputPath = ${JS_OUTPUT};

let content = readFileSync(templatePath, 'utf-8');

// Replace butler name placeholder
content = content.replace(/\{\{butler_name\}\}/g, butlerName);

// Update frontmatter — change name to 'active', record base preset
const presetName = content.match(/^---\nname:\s*([A-Za-z0-9-]+)/m)?.[1] || presetFallback;
content = content.replace(
  /^---\nname:\s*[A-Za-z0-9-]+/m,
  '---\nname: active\nbase: ' + presetName + '\nbase_locale: ' + templateLocale
);

// Build language/formality directive
const langDirective = [];
langDirective.push('');
langDirective.push('## Language & Formality');
langDirective.push('');
langDirective.push('**Language:** ' + lang);

switch (formality) {
  case 'casual':
    langDirective.push('**Register:** Casual. Like talking to a colleague. Contractions, informal phrasing.');
    break;
  case 'formal':
    langDirective.push('**Register:** Formal and deferential. Complete sentences, no contractions, respectful address.');
    break;
  default: // polite
    langDirective.push('**Register:** Professional and polite. Clear, measured, neither stiff nor casual.');
    break;
}

if (tone && tone.trim()) {
  langDirective.push('**Tone note:** ' + tone.trim());
}

// Append language section before ## Scenario Responses or at end
const scenarioIdx = content.indexOf('## Scenario Responses');
if (scenarioIdx !== -1) {
  content = content.slice(0, scenarioIdx) + langDirective.join('\n') + '\n\n' + content.slice(scenarioIdx);
} else {
  content += '\n' + langDirective.join('\n') + '\n';
}

writeFileSync(outputPath, content);
"
