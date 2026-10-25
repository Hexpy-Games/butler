import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Input } from "../Input";
import { TimePicker } from "./TimePicker";

// #region recipe: Daily run time
function DailyRunTime() {
  const [time, setTime] = useState("04:00");
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="run-time" label="Time" description="Runs only while Butler is on."
        control={<TimePicker id="run-time" value={time} onValueChange={setTime} locale="en-US" aria-label="Time" pickerLabel="Choose time" />} />
    </SettingsFieldScopeProvider>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Pick a time of day: type it into the segments, or choose it on wheel columns.",
  whenToUse: ["A daily time setting (a run time, a quiet-hours bound)", "Any HH:MM value the user picks"],
  whenNotToUse: [
    { when: "A few fixed choices (morning, evening)", use: "Select" },
    { when: "A duration or a count of minutes", use: "Input" },
  ],
  recipes: [{ name: "Daily run time", description: "In a SettingsField; the label names what runs, the description says when it can run.", render: () => <DailyRunTime /> }],
  doDont: [
    {
      do: { caption: "The locale writes the time (오전 4:00, 4:00 AM, 04:00) and the wheels pick it.", render: () => <DailyRunTime /> },
      dont: { caption: "A free text field accepts \"4am\", \"25:00\" and blanks.", render: () => <Input aria-label="Time" defaultValue="4am" /> },
    },
  ],
  content: [
    "pickerLabel is the clock button's name: \"Choose time\" / \"시간 고르기\".",
    "Pass the app locale; the hour cycle, segment order and day-period words come from Intl, never from hand-written strings.",
    "The value is always \"HH:MM\" in 24 hours; format it for display with Intl, not by hand.",
  ],
  accessibility: [
    "The field is role=group named by aria-label; each segment is a spinbutton named by Intl.DisplayNames (Hour, Minute, AM/PM).",
    "Digits fill a segment and advance; ↑/↓ step and wrap; ←/→ and Tab move; Home/End set min/max; A/P or the period's first letter sets the period.",
    "Enter or Alt+↓ opens the wheels; in a wheel ↑/↓/Home/End pick, ←/→ change column, Enter/Space or Escape close and return focus to the hour.",
    "Keyboard focus in a wheel is an inset ring, since the wheel clips its rows.",
  ],
  tokens: [
    "--control-height-lg", "--surface-raised", "--accent", "--focus-ring", "--focus-ring-width", "--focus-ring-color",
    "--selection", "--selection-strong", "--menu-item-height", "--motion-fast", "--radius-control",
  ],
};
