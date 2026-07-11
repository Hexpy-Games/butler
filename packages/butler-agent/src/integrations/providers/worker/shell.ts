import { augmentedPath, buildReasoningConfig, createOpenAIResponse, DEFAULT_WORKER_TOOL_ROUNDS, functionCallContinuationItems, getButlerRuntime, logPromptCacheStats, recordPromptCacheMetric, resolveOpenAIPromptCacheConfig, resolveWorkerShellOpenAIModel, SHELL_TOOL, toCodexStatelessInput } from "../openai/runtime.ts";
import { basename, join } from "path";
import { budgetToolOutput } from "../../../agent/context/tool-output-budgeter.ts";
import { buildWorkerInstructions, buildWorkerMemoryContextInstruction, loadFileIfExists } from "./context.ts";
import { clampTimeout, reportWorkerActivity, summarizeWorkerShellWorkBlock, truncateForLog, withWorkerActivityHeartbeat, workerActivityUpdateForShellCommand, workerEvidenceActivityTitle, workerEvidenceStatusLineForCommand, workerReportingTitle } from "./activity.ts";
import { extractResponseText, finalNoToolInstructions, getButlerData, getButlerHome, getFunctionCalls, MAX_TOOL_ROUNDS, modelFacingFunctionTools, parseToolArguments, writeWorkerTrace } from "../shared/runtime-support.ts";
import { resolveDynamicOpenAIModel } from "../openai/models.ts";
import { resolveRuntimeMessageLanguage } from "../../../agent/output/messages.ts";
import { spawn } from "child_process";
import { type ShellTaskOptions, workerEvidenceStatusLine, type WorkerOptions, workerPlanningStatusLine, workerReportingStatusLine } from "../runtime-contracts.ts";



export async function executeShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}> {
  return await new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        PATH: augmentedPath(),
        BUTLER_HOME: getButlerHome(),
        BUTLER_DATA: getButlerData(),
        BUTLER_WORKER: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const settle = (result: { stdout: string; stderr: string; exit_code: number | null; timed_out: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle({
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        exit_code: null,
        timed_out: timedOut,
      });
    });
    child.on("close", (code) => {
      settle({
        stdout,
        stderr,
        exit_code: timedOut ? null : (code ?? 0),
        timed_out: timedOut,
      });
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKillTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();
  });
}



export async function runShellTask(options: ShellTaskOptions): Promise<string> {
  if (getButlerRuntime() !== "codex-api") {
    throw new Error("runShellTask is only available when BUTLER_RUNTIME=codex-api");
  }
  const resolution = resolveWorkerShellOpenAIModel(options.model);
  const model = await resolveDynamicOpenAIModel(resolution.model);
  const reasoning = buildReasoningConfig(resolution);
  const log = options.log ?? (() => {});
  const promptCache = resolveOpenAIPromptCacheConfig(options.cacheScope ?? "tool-prompt");
  const codexStatelessInput = toCodexStatelessInput(options.prompt);
  const messageLanguage = options.messageLanguage ?? resolveRuntimeMessageLanguage();
  const shellTools = modelFacingFunctionTools([SHELL_TOOL]);

  await reportWorkerActivity(options.onActivity, {
    phase: "planning",
    statusLine: "Planning: choosing the worker step path.",
    currentTitle: messageLanguage === "ko" ? "워커 실행 경로를 정합니다." : "Choosing the worker step path.",
  });
  let response = await withWorkerActivityHeartbeat(
    options.onActivity,
    "planning",
    workerPlanningStatusLine,
    () => createOpenAIResponse({
      model,
      store: true,
      ...promptCache,
      instructions: options.instructions,
      tools: shellTools,
      reasoning,
      input: options.prompt,
      __butler_codex_stateless_input: codexStatelessInput,
    }),
  );
  const shellToolNames = new Set(["run_shell"]);
  const initialFunctionCallItems = functionCallContinuationItems(response, shellToolNames);
  if (initialFunctionCallItems.length > 0) {
    codexStatelessInput.push(...initialFunctionCallItems);
  }
  recordPromptCacheMetric(response, {
    model,
    scope: options.cacheScope ?? "tool-prompt",
    promptCache,
  });
  logPromptCacheStats(response, log, promptCache);

  const maxToolRounds = Math.max(1, Math.min(options.maxToolRounds ?? MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS));

  for (let round = 0; round < maxToolRounds; round++) {
    const calls = getFunctionCalls(response, new Set(["run_shell"]));
    if (calls.length === 0) {
      const text = extractResponseText(response);
      if (!text) throw new Error("Worker finished without a text result");
      await reportWorkerActivity(options.onActivity, {
        phase: "reporting",
        statusLine: "Reporting: composing the worker result.",
        currentTitle: workerReportingTitle(messageLanguage),
      });
      return text;
    }

    const toolOutputs: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      const parsedArgs = parseToolArguments(call.arguments);

      const command = typeof parsedArgs.command === "string" ? parsedArgs.command.trim() : "";
      if (!command) {
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            stdout: "",
            stderr: "run_shell requires a non-empty command",
            exit_code: 64,
            timed_out: false,
          }),
        });
        continue;
      }

      await reportWorkerActivity(
        options.onActivity,
        workerActivityUpdateForShellCommand(command, call.call_id, messageLanguage),
      );
      const timeoutMs = clampTimeout(parsedArgs.timeout_ms);
      const justification =
        typeof parsedArgs.justification === "string" && parsedArgs.justification.trim()
          ? ` (${parsedArgs.justification.trim()})`
          : "";

      log(`run_shell${justification}: ${command}`);
      const result = await executeShellCommand(command, options.projectPath, timeoutMs);
      const budgetedResult = budgetToolOutput({
        result,
        command,
        cwd: options.projectPath,
        maxModelTokens: 1_200,
      });
      log(`run_shell result: exit=${result.exit_code ?? "null"} timed_out=${result.timed_out}`);
      if (result.stdout.trim()) log(`stdout:\n${truncateForLog(result.stdout.trim())}`);
      if (result.stderr.trim()) log(`stderr:\n${truncateForLog(result.stderr.trim())}`);
      if (budgetedResult.butler_tool_artifact) {
        log(`tool output compacted: artifact=${budgetedResult.butler_tool_artifact.id} raw_tokens=${budgetedResult.butler_tool_artifact.raw_tokens} compact_tokens=${budgetedResult.butler_tool_artifact.compact_tokens}`);
      }
      await reportWorkerActivity(options.onActivity, {
        phase: "consolidating",
        statusLine: workerEvidenceStatusLineForCommand(command, 0),
        currentTitle: workerEvidenceActivityTitle(command, messageLanguage),
        workBlock: summarizeWorkerShellWorkBlock(command, call.call_id, messageLanguage, "delivered"),
      });

      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(budgetedResult),
      });
    }

    codexStatelessInput.push(...toolOutputs);
    if (round >= maxToolRounds - 1) {
      await reportWorkerActivity(options.onActivity, {
        phase: "reporting",
        statusLine: workerReportingStatusLine(0),
        currentTitle: workerReportingTitle(messageLanguage),
      });
      const finalResponse = await withWorkerActivityHeartbeat(
        options.onActivity,
        "reporting",
        workerReportingStatusLine,
        () => createOpenAIResponse({
          model,
          store: true,
          ...promptCache,
          instructions: finalNoToolInstructions(options.instructions),
          reasoning,
          previous_response_id: response.id,
          input: toolOutputs,
          __butler_codex_stateless_input: codexStatelessInput,
        }),
      );
      recordPromptCacheMetric(finalResponse, {
        model,
        scope: options.cacheScope ?? "tool-prompt",
        promptCache,
      });
      logPromptCacheStats(finalResponse, log, promptCache);
      const text = extractResponseText(finalResponse);
      if (!text) throw new Error("Worker reached tool budget and final synthesis returned no text result");
      return text;
    }

    const onlyCallArgs = calls.length === 1 ? parseToolArguments(calls[0]!.arguments) : {};
    const onlyCommand = typeof onlyCallArgs.command === "string" ? onlyCallArgs.command : "";
    const evidenceStatusLine = (elapsedMs: number) =>
      toolOutputs.length === 1 && onlyCommand
        ? workerEvidenceStatusLineForCommand(onlyCommand, elapsedMs)
        : workerEvidenceStatusLine(elapsedMs);
    response = await withWorkerActivityHeartbeat(
      options.onActivity,
      "consolidating",
      evidenceStatusLine,
      () => createOpenAIResponse({
        model,
        store: true,
        ...promptCache,
        instructions: options.instructions,
        tools: shellTools,
        reasoning,
        previous_response_id: response.id,
        input: toolOutputs,
        __butler_codex_stateless_input: codexStatelessInput,
      }),
    );
    const functionCallItems = functionCallContinuationItems(response, shellToolNames);
    if (functionCallItems.length > 0) {
      codexStatelessInput.push(...functionCallItems);
    }
    recordPromptCacheMetric(response, {
      model,
      scope: options.cacheScope ?? "tool-prompt",
      promptCache,
    });
    logPromptCacheStats(response, log, promptCache);
  }

  throw new Error(`Worker exceeded ${MAX_TOOL_ROUNDS} tool rounds without finishing`);
}



export async function runWorkerTask(options: WorkerOptions): Promise<string> {
  const taskId = basename(options.taskDir);
  const requestPath = join(options.taskDir, "request.md");
  const taskDesc = loadFileIfExists(requestPath);
  if (!taskDesc) {
    throw new Error(`Worker request not found at ${requestPath}`);
  }

  const prompt = `Task ID: ${taskId}
Project path: ${options.projectPath}

${buildWorkerMemoryContextInstruction()}

Task:
${taskDesc}`;

  writeWorkerTrace(options.taskDir, "worker.prompt.built", {
    prompt_chars: prompt.length,
    task_chars: taskDesc.length,
    has_memory_instruction: prompt.includes("memory"),
  });

  return await runShellTask({
    prompt,
    projectPath: options.projectPath,
    taskDir: options.taskDir,
    model: options.model,
    instructions: buildWorkerInstructions(),
    cacheScope: "worker",
    log: options.log,
    onActivity: options.onActivity,
    messageLanguage: resolveRuntimeMessageLanguage(),
    maxToolRounds: DEFAULT_WORKER_TOOL_ROUNDS,
  });
}
