// test-category: pure-logic
/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShieldCheck } from "../../components/Icons";
import { SetupWizardShell } from "../SetupWizardShell";
import { SetupWizardStepAction, SetupWizardStepCard } from "./SetupWizardStepCard";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const STEPS = [{ id: "a", label: "Welcome" }, { id: "b", label: "Consent" }, { id: "c", label: "Connect AI" }];
let root: Root | null = null;

function setup(reducedMotion = false) {
  const dom = new JSDOM('<div id="root"></div>');
  const matchMedia = (query: string) => ({ matches: reducedMotion && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} });
  Object.assign(dom.window, { matchMedia });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  return dom.window.document;
}

async function render(node: ReactNode) {
  await act(async () => root!.render(node));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function card(contentKey: string, onBack?: () => void) {
  return (
    <SetupWizardStepCard activeIndex={1} backLabel="Back" contentKey={contentKey} icon={<ShieldCheck size="lg" />} onBack={onBack}
      progressLabel="Setup steps" steps={STEPS} title={`Step ${contentKey}`} titleId="step-title"
      actions={<><SetupWizardStepAction text="Decline" /><SetupWizardStepAction forward text="Continue" /></>} />
  );
}

test("the step card shows back, the current step, a focusable title and only the forward action's arrow", async () => {
  const document = setup();
  let backs = 0;
  await render(card("consent", () => { backs += 1; }));
  const back = [...document.querySelectorAll("button")].find((button) => button.textContent === "Back")!;
  await act(async () => back.click());
  expect(backs).toBe(1);
  expect(document.querySelector('[aria-current="step"]')?.textContent).toContain("Consent");
  expect(document.getElementById("step-title")?.getAttribute("tabindex")).toBe("-1");
  const [decline, forward] = [...document.querySelectorAll('[data-slot="setup-step-footer"] button')];
  expect([decline.querySelectorAll("svg").length, forward.querySelectorAll("svg").length]).toEqual([0, 1]);
});

test("contentKey fades only after it changes, never on first render or under reduced motion", async () => {
  const document = setup();
  await render(card("consent"));
  const body = () => document.querySelector('[data-slot="setup-step-body"]');
  expect(body()?.getAttribute("data-motion")).toBeNull();
  await render(card("connect"));
  expect(body()?.getAttribute("data-motion")).toBe("enter");

  await act(async () => root?.unmount());
  const reduced = setup(true);
  await render(card("consent"));
  await render(card("connect"));
  expect(reduced.querySelector('[data-slot="setup-step-body"]')?.getAttribute("data-motion")).toBeNull();
});

function shell(stepKey: string, child: ReactNode) {
  return <SetupWizardShell anchor="top" embedded stepKey={stepKey} title="Butler" variant="focus">{child}</SetupWizardShell>;
}

test("stepKey swaps the card: an inert copy without ids fades out while the new card enters", async () => {
  const document = setup();
  await render(shell("intro", <p id="intro-title">Intro</p>));
  expect(document.querySelector("main")?.getAttribute("data-anchor")).toBe("top");
  await render(shell("steps", <p id="step-title">Step</p>));
  const ghost = document.querySelector('[data-stage="exit"]');
  expect(ghost?.textContent).toBe("Intro");
  expect(ghost?.closest('[aria-hidden="true"]')).not.toBeNull();
  expect(ghost?.querySelector("[id]")).toBeNull();
  expect(document.querySelector('[data-stage="enter"]')?.textContent).toBe("Step");
  expect(document.querySelectorAll("#step-title").length).toBe(1);
});

test("under reduced motion the card swaps at once", async () => {
  const document = setup(true);
  await render(shell("intro", <p>Intro</p>));
  await render(shell("steps", <p>Step</p>));
  expect(document.querySelector('[data-stage="exit"]')).toBeNull();
  expect(document.querySelector('[data-stage="current"]')?.textContent).toBe("Step");
});
