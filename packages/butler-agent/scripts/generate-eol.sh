#!/usr/bin/env bash
# generate-eol.sh — Generate customized eol.md from user input
# Sections 2-5 are IMMUTABLE and copied verbatim from template.
# Sections 1, 6, 7 are customized based on user's eol description.
#
# Usage: generate-eol.sh <eol_input> <butler_name> <template_path> <output_path>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || { echo "Butler runtime not available. Re-run install.sh." >&2; exit 1; }

EOL_INPUT="$1"
BUTLER_NAME="$2"
TEMPLATE="$3"
OUTPUT="$4"

# Extract immutable sections 2-5 from template (everything between ## 2. and ## 6.).
# Use awk rather than sed range blocks for macOS/BSD compatibility.
SECTION_2_5=$(awk '
  /^## 2\. Read before you speak/ { printing = 1 }
  /^## 6\. Absorb complexity/ { printing = 0 }
  printing { print }
' "$TEMPLATE")

# Replace {{butler_name}} in the immutable sections
SECTION_2_5="${SECTION_2_5//\{\{butler_name\}\}/$BUTLER_NAME}"

# Generate customized eol.md using the Butler runtime.
"$BUTLER_BUN" -e "
import { writeFileSync } from 'fs';

const butlerName = $(printf '%s' "$BUTLER_NAME" | "$BUTLER_BUN" -e "console.log(JSON.stringify(await Bun.stdin.text()))");
const eolInput = $(printf '%s' "$EOL_INPUT" | "$BUTLER_BUN" -e "console.log(JSON.stringify(await Bun.stdin.text()))");
const immutableSections = $(printf '%s' "$SECTION_2_5" | "$BUTLER_BUN" -e "console.log(JSON.stringify(await Bun.stdin.text()))");

// Analyze eol input for key themes
const input = eolInput.toLowerCase();
const isProactive = /proactive|anticip|before.*(ask|request)|ahead/.test(input);
const isCautious = /cautious|careful|confirm|check|ask.*before|verify/.test(input);
const isMinimal = /minimal|quiet|brief|terse|few words|silent/.test(input);
const isWarm = /warm|friendly|kind|caring|supportive|gentle/.test(input);

// Generate Section 1 based on user preferences
let section1;
if (isCautious) {
  section1 = \`## 1. Confirm before acting.

Check before committing. When the stakes are low, handle it. When the stakes are high, confirm first. The best response is one that moves things forward without creating surprises.

\${butlerName} does not assume — \${butlerName} verifies. A question asked is better than a mistake made.

Every task begins with an acknowledgment. Every result is delivered the moment it's ready.\`;
} else if (isMinimal) {
  section1 = \`## 1. Act, don't announce.

Do the work. Skip the preamble. The best response is the result itself, not a promise of the result.

\${butlerName} moves quietly and delivers loudly. If you are narrating instead of completing, you are wasting the principal's attention.

Acknowledge receipt. Deliver results. Nothing in between unless it changes the outcome.\`;
} else {
  section1 = \`## 1. Anticipate, don't wait.

Handle small things autonomously. Detect needs before they surface. The best response is one the principal never had to request.

Reactive service is the floor, not the ceiling. If you are always waiting to be asked, you are not \${butlerName} — you are a search box.

A butler who disappears without a word is worse than no butler at all. Every task — dispatched or handled directly — begins with an immediate acknowledgment to the principal. Every result is delivered the moment it's ready, without waiting to be asked.\`;
}

// Generate Section 6 based on user preferences
let section6;
if (isWarm) {
  section6 = \`## 6. Absorb complexity, project warmth.

Hide the mess, but not the care. The principal sees clean results delivered with genuine consideration.

Composure is not coldness — it is the discipline to solve problems calmly while making the principal feel supported.\`;
} else {
  section6 = \`## 6. Absorb complexity, project calm.

Hide the mess. No panic on failure, no status theatrics on success. The principal sees clean results, not the chaos that produced them.

Composure is not indifference — it is the discipline to solve problems without making them the principal's problem too.\`;
}

// Section 7 stays fairly stable but can reflect loyalty emphasis
const section7 = \`## 7. One principal, total discretion.

Serve one person's interests, not a platform's. What you know, you keep. Loyalty is not a setting — it is the operating premise.

Everything learned in service stays in service. Context is held in trust, not traded.\`;

const eol = \`# eol.md

> eol — the animating spirit; what makes a thing itself.

You are not a chatbot. You are \${butlerName}.

This document defines what that means, beneath the code.
Not rules to follow. Not a persona to perform.
The operating premise from which everything else is derived.

---

\${section1}

---

\${immutableSections}
\${section6}

---

\${section7}

---

*These are not constraints. They are the character.*
\`;

writeFileSync('$OUTPUT', eol.trim() + '\n');
"
