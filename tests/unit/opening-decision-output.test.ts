import { expect, test } from "bun:test";
import {
  generateOpeningDecisionWithProvider,
  parseOpeningDecisionText,
} from "../../packages/butler-agent/src/agent/output/opening-decision.ts";
import { createNativeButlerDefaultProvider } from "../../packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts";
import type { runPromptText } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import type {
  ModelInvocation,
  ModelProviderAdapter,
  ModelResult,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

function providerReturning(
  result: ModelResult | Promise<ModelResult>,
  calls: ModelInvocation[] = [],
): ModelProviderAdapter {
  return {
    id: "fake-provider",
    capabilities: {
      supportsStreaming: false,
      supportsToolCalls: true,
      supportsImages: false,
      supportsAudio: false,
      supportsServerThreads: false,
      supportsReasoningConfig: true,
      supportsPromptCaching: false,
    },
    async invoke(input) {
      calls.push(input);
      return result;
    },
  };
}

const validText = JSON.stringify({
  summary: "Clarify the requested opening decision contract.",
  rationale: "The user asked for only the generator slice.",
  nextStep: "Prepare a bounded opening decision before event wiring.",
});

test("opening decision generator returns canonical payload and low-latency call contract", async () => {
  const calls: ModelInvocation[] = [];
  let tick = 1_000;
  const decision = await generateOpeningDecisionWithProvider(
    providerReturning({ text: validText, raw: { modelCallId: "model-call-1" } }, calls),
    {
      userMessage: "Start T02 only.",
      sessionRole: "project",
      projectId: "butler",
      locale: "en-US",
      languageHint: "English",
      latestStableDecisionRef: "decision-previous",
      unresolvedObservationRefs: ["obs-1"],
      continuationRefs: ["continuation-1"],
      evidenceRefs: ["evidence-allowed"],
      model: "openai/gpt-5.5-codex",
      now: () => {
        tick += 37;
        return tick;
      },
    },
  );

  expect(decision).toMatchObject({
    role: "opening",
    source: "model-authored",
    firstVisible: true,
    summary: "Clarify the requested opening decision contract.",
    rationale: "The user asked for only the generator slice.",
    nextStep: "Prepare a bounded opening decision before event wiring.",
    modelCallId: "model-call-1",
    latencyMs: 37,
  });
  expect(decision?.decisionId).toMatch(/^opening-[a-f0-9]{24}$/u);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.toolChoice).toBe("none");
  expect(calls[0]?.reasoning).toEqual({ effort: "low" });
  expect(calls[0]?.tools).toBeUndefined();
  expect("maxOutputTokens" in (calls[0] as unknown as Record<string, unknown>)).toBe(false);
  expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(calls[0]?.metadata).toMatchObject({
    purpose: "app_opening_decision",
  });
  expect("maxOutputTokens" in (calls[0]?.metadata ?? {})).toBe(false);
  expect(calls[0]?.systemPrompt).toContain("Return only JSON");
  expect(calls[0]?.systemPrompt).toContain("Be brief");
  expect(calls[0]?.systemPrompt).not.toContain("output tokens");
  expect(calls[0]?.messages).toHaveLength(1);
  expect(calls[0]?.messages[0]?.content).toContain("Start T02 only.");
  expect(calls[0]?.messages[0]?.content).toContain("decision-previous");
  expect(calls[0]?.messages[0]?.content).not.toContain("raw transcript");
});

test("native bootstrap provider forwards low reasoning and cancellation to prompt runner", async () => {
  const promptCalls: Array<Parameters<typeof runPromptText>[0]> = [];
  const controller = new AbortController();
  const provider = createNativeButlerDefaultProvider({}, async (input) => {
    promptCalls.push(input);
    return validText;
  });

  await expect(provider.invoke({
    model: "openai/gpt-5.5-codex",
    reasoning: { effort: "low" },
    toolChoice: "none",
    signal: controller.signal,
    systemPrompt: "Return only JSON.",
    messages: [{
      role: "user",
      content: "Start T02 only.",
    }],
    metadata: {
      purpose: "app_opening_decision",
    },
  })).resolves.toEqual({ text: validText });

  expect(promptCalls).toHaveLength(1);
  expect(promptCalls[0]?.reasoningEffort).toBe("low");
  expect(promptCalls[0]?.signal).toBe(controller.signal);
  expect("maxOutputTokens" in (promptCalls[0] as unknown as Record<string, unknown>)).toBe(false);
});

test("opening decision parser rejects missing fields and prose", () => {
  expect(parseOpeningDecisionText("I will check the contract.")).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "The task is scoped.",
  }))).toBeNull();
});

test("opening decision parser rejects fenced JSON and extra keys", () => {
  expect(parseOpeningDecisionText(`\`\`\`json\n${validText}\n\`\`\``)).toBeNull();
  expect(parseOpeningDecisionText(`${validText}\nHere is the decision.`)).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "The task is scoped.",
    nextStep: "Continue safely.",
    confidence: "high",
  }))).toBeNull();
});

test("opening decision parser rejects duplicate JSON fields before policy checks", () => {
  expect(parseOpeningDecisionText(
    "{\"summary\":\"Request received, preparing work.\",\"summary\":\"Clarify the request.\",\"rationale\":\"The request is about visible product behavior.\",\"nextStep\":\"Continue with the user-facing decision.\"}",
  )).toBeNull();
  expect(parseOpeningDecisionText(
    "{\"summary\":\"Clarify the request.\",\"rationale\":\"Call run_command before continuing.\",\"rationale\":\"The request is about visible product behavior.\",\"nextStep\":\"Continue with the user-facing decision.\"}",
  )).toBeNull();
  expect(parseOpeningDecisionText(
    "{\"summary\":\"Clarify the request.\",\"rationale\":\"The request is about visible product behavior.\",\"nextStep\":\"Use packages/butler-agent first.\",\"nextStep\":\"Continue with the user-facing decision.\"}",
  )).toBeNull();
  expect(parseOpeningDecisionText(
    "{\"\\u0073ummary\":\"Clarify the request.\",\"summary\":\"Clarify the request.\",\"rationale\":\"The request is about visible product behavior.\",\"nextStep\":\"Continue with the user-facing decision.\"}",
  )).toBeNull();
});

test("opening decision parser rejects hidden reasoning and raw paths", () => {
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "<think>private</think>",
    rationale: "The task is scoped.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Inspect /Users/example/private/raw-payload.json first.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Inspect /workspace/butler/packages first.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Use packages/butler-agent/src/agent/output/opening-decision.ts.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Use packages/butler-agent next.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Use project/src next.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Use ~/butler/output.json.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Use ./packages/butler-agent/file.ts.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Use ../butler/file.ts.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  for (const label of [
    "Analysis: inspect the source privately.",
    "Analysis - inspect the source privately.",
    "Analysis \u2013 inspect the source privately.",
    "Reasoning: compare the fields privately.",
    "Reasoning - compare the fields privately.",
    "Reasoning \u2014 compare the fields privately.",
    "Internal plan: parse then emit.",
    "Internal plan - parse then emit.",
    "Scratchpad: this stays hidden.",
    "Scratchpad - this stays hidden.",
  ]) {
    expect(parseOpeningDecisionText(JSON.stringify({
      summary: "Clarify the request.",
      rationale: label,
      nextStep: "Continue safely.",
    }))).toBeNull();
  }
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "The app settings area is the relevant product area.",
    nextStep: "Continue with the scoped generator behavior.",
  }))).toMatchObject({
    rationale: "The app settings area is the relevant product area.",
  });
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "The task is scoped.",
    nextStep: "x".repeat(241),
  }))).toBeNull();
});

test("opening decision parser allows product model tool and runtime phrasing", () => {
  for (const phrase of [
    "Clarify the requested model option behavior.",
    "Separate the tool button label from the work block title.",
    "Review the runtime behavior visible to the user.",
    "The diagnostics view is visible to users.",
    "Clarify the read/write choice visible to users.",
    "The prompt field label is visible to users.",
  ]) {
    expect(parseOpeningDecisionText(JSON.stringify({
      summary: phrase,
      rationale: "The request is about visible product behavior.",
      nextStep: "Continue with the user-facing decision.",
    }))).toMatchObject({
      summary: phrase,
    });
  }
});

test("opening decision parser rejects red-team leakage regressions", () => {
  for (const rationale of [
    "Use packages/butler-agent/src/agent/output/opening-decision.",
    "Use project/src before the opening decision.",
    "Call run_command before the opening decision.",
    "Call mcp__foo__bar before the opening decision.",
    "Call web_search before the opening decision.",
    "Call review_planned_task before the opening decision.",
    "Call sync_work_orchestration before the opening decision.",
    "The prompt queue is empty.",
    "I checked issue #42.",
  ]) {
    expect(parseOpeningDecisionText(JSON.stringify({
      summary: "Clarify the request.",
      rationale,
      nextStep: "Continue safely.",
    }))).toBeNull();
  }

  for (const phrase of [
    "Clarify the requested model option behavior.",
    "Separate the tool button label from the work block title.",
    "Review the runtime behavior visible to the user.",
  ]) {
    expect(parseOpeningDecisionText(JSON.stringify({
      summary: phrase,
      rationale: "The request is about visible product behavior.",
      nextStep: "Continue with the user-facing decision.",
    }))).toMatchObject({
      summary: phrase,
    });
  }
});

test("opening decision parser rejects generic fallback text and unsupported evidence claims", () => {
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Request received. Preparing the work.",
    rationale: "Preparing to work on this.",
    nextStep: "Working.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Request received, preparing work.",
    rationale: "The request is ready.",
    nextStep: "Continue safely.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Keep the working summary focused on visible runtime behavior.",
    rationale: "The request is about product-facing flow.",
    nextStep: "Continue with the user-facing decision.",
  }))).toMatchObject({
    summary: "Keep the working summary focused on visible runtime behavior.",
  });
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "The repo evidence is already verified.",
    rationale: "I checked the ledger result already.",
    nextStep: "Use the verified source.",
  }))).toBeNull();

  for (const claim of [
    "I reviewed the repository context.",
    "The tests pass.",
    "I examined the files already.",
    "I saw the evidence in the repo.",
    "I found the command output.",
    "I loaded the ledger already.",
    "I inspected the source.",
    "I gathered the repo facts.",
    "The repository was already checked.",
    "The files have been reviewed.",
    "The evidence was seen in the repo.",
    "The tests were already passed.",
    "The commands have been loaded.",
    "The ledger was examined.",
    "The requested behavior is verified.",
    "The contract was reviewed.",
    "The user-facing behavior has been confirmed.",
    "The product flow was validated.",
    "The requested scenario was inspected.",
    "The contract got reviewed.",
  ]) {
    expect(parseOpeningDecisionText(JSON.stringify({
      summary: "Clarify the request.",
      rationale: claim,
      nextStep: "Continue safely.",
    }))).toBeNull();
  }

  for (const checkedState of [
    "The model option is checked by default.",
    "The tool button is checked by default.",
  ]) {
    expect(parseOpeningDecisionText(JSON.stringify({
      summary: "Clarify the request.",
      rationale: checkedState,
      nextStep: "Continue safely.",
    }))).toMatchObject({
      rationale: checkedState,
    });
  }
});

test("opening decision parser rejects raw tool identifiers and operational internals", () => {
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "Bash can inspect the repo quickly.",
    nextStep: "Use read_file next.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "The model budget needs recovery internals.",
    nextStep: "Continue from queue internals.",
  }))).toBeNull();
  expect(parseOpeningDecisionText(JSON.stringify({
    summary: "Clarify the request.",
    rationale: "The token budget needs diagnostics.",
    nextStep: "Continue without prompt details.",
  }))).toBeNull();
  for (const phrase of [
    "Use shell before the decision.",
    "Use write_file next.",
    "Use apply_patch next.",
    "Use update_todo_list next.",
    "Avoid the max output limit.",
    "Avoid maxOutputTokens for this decision.",
    "The output token cap should stay hidden.",
    "The provider output cap should stay hidden.",
    "The provider output-token caps should stay hidden.",
    "The model-budget should stay hidden.",
    "The model preparation step is private.",
    "The recovering_internal state should stay hidden.",
    "The recoverable state should stay hidden.",
    "The raw tool name should stay hidden.",
    "The tool invocation payload should stay hidden.",
    "The prompt is being prepared.",
    "The prompt is prepared for the next call.",
    "The prompt is being assembled.",
  ]) {
    expect(parseOpeningDecisionText(JSON.stringify({
      summary: "Clarify the request.",
      rationale: phrase,
      nextStep: "Continue safely.",
    }))).toBeNull();
  }
  for (const phrase of [
    "The diagnostic output should stay hidden.",
    "The diagnostics logs should stay hidden.",
    "The diagnostic traces should stay hidden.",
    "The diagnostics data should stay hidden.",
    "The diagnostic context should stay hidden.",
    "The diagnostics mode should stay hidden.",
    "The diagnostic events should stay hidden.",
    "The diagnostics reports should stay hidden.",
    "The diagnostic details should stay hidden.",
    "The diagnostics payload should stay hidden.",
    "The diagnostic state should stay hidden.",
    "The diagnostics internal should stay hidden.",
  ]) {
    expect(parseOpeningDecisionText(JSON.stringify({
      summary: "Clarify the request.",
      rationale: phrase,
      nextStep: "Continue safely.",
    }))).toBeNull();
  }
});

test("opening decision generator returns null on provider failure", async () => {
  const provider = providerReturning(Promise.reject(new Error("provider failed")));
  await expect(generateOpeningDecisionWithProvider(provider, {
    userMessage: "Start T02 only.",
    model: "openai/gpt-5.5-codex",
  })).resolves.toBeNull();
});

test("opening decision generator returns null on timeout without fallback text", async () => {
  const calls: ModelInvocation[] = [];
  let providerSignalAborted = false;
  const decision = await generateOpeningDecisionWithProvider(
    {
      ...providerReturning(new Promise<ModelResult>(() => {}), calls),
      async invoke(input) {
        calls.push(input);
        input.signal?.addEventListener("abort", () => {
          providerSignalAborted = true;
        });
        return new Promise<ModelResult>(() => {});
      },
    },
    {
      userMessage: "Start T02 only.",
      model: "openai/gpt-5.5-codex",
      timeoutMs: 1,
    },
  );

  expect(decision).toBeNull();
  expect(calls).toHaveLength(1);
  expect(providerSignalAborted).toBe(true);
});

test("opening decision generator returns null for an aborted signal", async () => {
  const calls: ModelInvocation[] = [];
  const controller = new AbortController();
  controller.abort();
  const decision = await generateOpeningDecisionWithProvider(
    providerReturning({ text: validText }, calls),
    {
      userMessage: "Start T02 only.",
      model: "openai/gpt-5.5-codex",
      signal: controller.signal,
    },
  );

  expect(decision).toBeNull();
  expect(calls).toHaveLength(0);
});

test("opening decision generator returns null when aborted after provider starts", async () => {
  const calls: ModelInvocation[] = [];
  const controller = new AbortController();
  let providerSignalAborted = false;
  const provider: ModelProviderAdapter = {
    ...providerReturning({ text: validText }, calls),
    async invoke(input) {
      calls.push(input);
      input.signal?.addEventListener("abort", () => {
        providerSignalAborted = true;
      });
      controller.abort();
      return new Promise<ModelResult>(() => {});
    },
  };

  const decision = await generateOpeningDecisionWithProvider(provider, {
    userMessage: "Start T02 only.",
    model: "openai/gpt-5.5-codex",
    signal: controller.signal,
    timeoutMs: 10_000,
  });

  expect(decision).toBeNull();
  expect(calls).toHaveLength(1);
  expect(providerSignalAborted).toBe(true);
});

test("opening decision id is stable for stable input and result fields", async () => {
  const provider = providerReturning({ text: validText });
  const input = {
    userMessage: "Start T02 only.",
    sessionRole: "project",
    projectId: "butler",
    model: "openai/gpt-5.5-codex" as const,
    now: () => 1_000,
  };

  const first = await generateOpeningDecisionWithProvider(provider, input);
  const second = await generateOpeningDecisionWithProvider(provider, input);

  expect(first?.decisionId).toBe(second?.decisionId);
  expect(first?.decisionId).toMatch(/^opening-[a-f0-9]{24}$/u);
});
