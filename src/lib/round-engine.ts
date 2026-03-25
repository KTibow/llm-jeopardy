import { createParser, type EventSourceMessage } from "eventsource-parser";
import { normalizeTriviaResponse } from "./format";
import {
  getChatCompletionsUrl,
  getOpenRouterHeaders,
  isOpenRouterBaseUrl,
} from "./gateway";
import type {
  AttemptResult,
  ClueCard,
  ContestantDefinition,
  GatewayConfig,
  RoundStreamEvent,
  StreamChannel,
} from "./game-types";

export async function runJeopardyRound({
  clue,
  contestants,
  gateway,
  writeEvent,
}: {
  clue: ClueCard;
  contestants: ContestantDefinition[];
  gateway: GatewayConfig;
  writeEvent: (e: RoundStreamEvent) => void;
}) {
  writeEvent({
    type: "round_started",
    clue,
    contestantIds: contestants.map((contestant) => contestant.id),
  });

  let eligible = contestants;
  const pastWrongAnswers: string[] = [];
  let attempt = 1;

  while (eligible.length > 0) {
    writeEvent({ type: "attempt_started", attempt, contestantIds: eligible.map(c => c.id), pastWrongAnswers });
    const { buzzedResult, failedIds } = await runAttemptRace(
      attempt,
      clue,
      eligible,
      gateway,
      pastWrongAnswers,
      writeEvent,
    );

    if (!buzzedResult) {
      writeEvent({ type: "round_finished", outcome: "skipped", winnerId: null, canonicalResponse: clue.canonicalResponse, reason: attempt === 1 ? "all_passed" : "all_missed" });
      return;
    }

    const correct = normalizeTriviaResponse(buzzedResult.normalizedAnswer) === normalizeTriviaResponse(clue.canonicalResponse);
    writeEvent({ type: "judged", attempt, contestantId: buzzedResult.contestantId, correct, canonicalResponse: clue.canonicalResponse, pointsDelta: correct ? clue.value : -clue.value, normalizedExpected: clue.canonicalResponse, normalizedActual: buzzedResult.normalizedAnswer });

    if (correct) {
      writeEvent({ type: "round_finished", outcome: "correct", winnerId: buzzedResult.contestantId, canonicalResponse: clue.canonicalResponse, reason: "correct" });
      return;
    }

    const wrongAnswer = buzzedResult.answerLine || buzzedResult.rawResponse || clue.canonicalResponse;
    if (!pastWrongAnswers.includes(wrongAnswer)) {
      pastWrongAnswers.push(wrongAnswer);
    }

    eligible = eligible.filter(c => c.id !== buzzedResult.contestantId && !failedIds.includes(c.id));

    if (eligible.length === 0) {
      writeEvent({ type: "round_finished", outcome: "skipped", winnerId: null, canonicalResponse: clue.canonicalResponse, reason: "all_missed" });
      return;
    }

    for (let i = 3; i > 0; i--) {
      writeEvent({ type: "rebound_tick", secondsLeft: i });
      await new Promise(r => setTimeout(r, 1000));
    }
    writeEvent({ type: "rebound_tick", secondsLeft: 0 });

    attempt++;
  }
}

async function runAttemptRace(
  attempt: number,
  clue: ClueCard,
  contestants: ContestantDefinition[],
  gateway: GatewayConfig,
  pastWrongAnswers: string[],
  writeEvent: (event: RoundStreamEvent) => void,
) {
  const controllers = new Map<string, AbortController>();
  const results = new Map<string, AttemptResult>();
  let buzzedId: string | null = null;

  const tasks = contestants.map(async (contestant) => {
    const controller = new AbortController();
    controllers.set(contestant.id, controller);

    writeEvent({ type: "contestant_started", attempt, contestantId: contestant.id });

    try {
      const result = await streamAttempt(clue, contestant, gateway, attempt, pastWrongAnswers, controller,
        (channel, delta) => writeEvent({ type: "contestant_delta", attempt, contestantId: contestant.id, channel, delta }),
        (buzzMs: number) => {
          if (buzzedId) return;
          buzzedId = contestant.id;
          writeEvent({ type: "buzz_locked", attempt, contestantId: contestant.id, buzzMs });
          for (const [otherId, ctrl] of controllers.entries()) {
            if (otherId !== contestant.id) ctrl.abort();
          }
        }
      );
      results.set(contestant.id, result);
      writeEvent({ type: "contestant_complete", result });
    } catch (error: unknown) {
      if (isAbortLikeError(error) || controller.signal.aborted) {
        const result: AttemptResult = {
          contestantId: contestant.id,
          attempt,
          decision: "none",
          status: "aborted",
          buzzMs: null,
          rawResponse: "",
          answerLine: null,
          normalizedAnswer: null,
          thoughtAboutCorrectAnswer: false,
        };
        results.set(contestant.id, result);
        writeEvent({ type: "contestant_complete", result });
        return;
      }
      console.warn(`[Inference Failed] ${contestant.id}:`, error);
      const result: AttemptResult = {
        contestantId: contestant.id,
        attempt,
        decision: "none",
        status: "failed",
        buzzMs: null,
        rawResponse: "",
        answerLine: null,
        normalizedAnswer: null,
        thoughtAboutCorrectAnswer: false,
      };
      results.set(contestant.id, result);
      writeEvent({ type: "contestant_complete", result });
    }
  });

  const raceTimeout = setTimeout(() => {
    for (const ctrl of controllers.values()) ctrl.abort();
  }, 25000);

  await Promise.all(tasks);
  clearTimeout(raceTimeout);

  const failedIds = Array.from(results.values()).filter(r => r.status === 'failed').map(r => r.contestantId);
  return {
    buzzedResult: buzzedId ? results.get(buzzedId) : null,
    failedIds
  };
}

async function streamAttempt(
  clue: ClueCard,
  contestant: ContestantDefinition,
  gateway: GatewayConfig,
  attempt: number,
  pastWrongAnswers: string[],
  controller: AbortController,
  onDelta: (channel: Extract<StreamChannel, "reasoning_content" | "content">, delta: string) => void,
  onBuzz: (buzzMs: number) => void,
): Promise<AttemptResult> {
  const isOpenRouter = isOpenRouterBaseUrl(gateway.baseUrl);
  const url = getChatCompletionsUrl(gateway.baseUrl);

  const state = {
    raw: "",
    reasoning: "",
    decisionLocked: false,
    start: performance.now(),
    buzzMs: null as number | null,
  };
  const prompt = [
    `Category: ${clue.category}`, `Value: $${clue.value}`, `Clue: ${clue.clue}`,
    `Expected format: ${clue.answerKind === "who" ? "Who is ...?" : "What is ...?"}`,
    pastWrongAnswers.length > 0 ? `Previous wrong answers (DO NOT REPEAT): ${pastWrongAnswers.join(" | ")}` : ''
  ].filter(Boolean).join("\n");

  const instructions = "Decide if you know the exact answer. First visible line MUST be exactly BUZZ or PASS. If you BUZZ, the next line is the answer in form of a question. If you PASS, do not output anything else. No chatter.";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${gateway.apiKey.trim()}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (isOpenRouter) {
    Object.assign(headers, getOpenRouterHeaders());
  }

  const body: Record<string, unknown> = {
    model: contestant.model,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: prompt },
    ],
    stream: true,
  };

  if (isOpenRouter) {
    body.reasoning = {
      enabled: true,
      effort: "medium",
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Stream fail: ${res.status}`);

    const parser = createParser({
      onEvent: (e: EventSourceMessage) => {
        if (e.data === "[DONE]") return;
        try {
          const payload = JSON.parse(e.data) as unknown;
          const { reasoningDelta, contentDelta } =
            extractChatCompletionDeltas(payload);

          if (reasoningDelta) {
            state.reasoning += reasoningDelta;
            onDelta("reasoning_content", reasoningDelta);
          }
          if (contentDelta) {
            state.raw += contentDelta;
            onDelta("content", contentDelta);

            if (!state.decisionLocked && state.raw.trimStart()) {
              const trimmed = state.raw.trimStart();
              if (/^BUZZ/i.test(trimmed)) {
                state.decisionLocked = true;
                state.buzzMs = performance.now() - state.start;
                onBuzz(state.buzzMs);
              } else if (/^PASS/i.test(trimmed)) {
                state.decisionLocked = true;
                controller.abort();
              }
            }
          }
        } catch {
          return;
        }
      }
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } catch (error: unknown) {
    if (!isAbortLikeError(error) && !controller.signal.aborted) {
      throw error;
    }
  }

  const trimmed = state.raw.replace(/\r/g, "").trim();
  const isBuzz = /^BUZZ\b/i.test(trimmed);
  const isPass = /^PASS\b/i.test(trimmed);
  const answerLine = isBuzz ? trimmed.replace(/^BUZZ\b/i, "").split("\n").map(l => l.trim()).find(Boolean) || null : null;
  const thoughtAboutCorrectAnswer = state.reasoning.length > 0 && normalizeTriviaResponse(state.reasoning).includes(normalizeTriviaResponse(clue.answer));

  return { contestantId: contestant.id, attempt, decision: isBuzz ? "buzz" : isPass ? "pass" : "none", status: controller.signal.aborted ? (isBuzz || isPass ? "completed" : "aborted") : "completed", buzzMs: state.buzzMs, rawResponse: state.raw, answerLine, normalizedAnswer: normalizeTriviaResponse(answerLine), thoughtAboutCorrectAnswer };
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error
      ? error.name === "AbortError"
      : false;
}

function extractChatCompletionDeltas(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { reasoningDelta: "", contentDelta: "" };
  }

  const candidate = payload as {
    choices?: Array<{
      delta?: {
        content?: string | Array<{ text?: string }>;
        reasoning?: string;
        reasoning_content?: string;
      };
    }>;
  };

  const delta = candidate.choices?.[0]?.delta;
  if (!delta) {
    return { reasoningDelta: "", contentDelta: "" };
  }

  const reasoningDelta =
    typeof delta.reasoning === "string"
      ? delta.reasoning
      : typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : "";

  let contentDelta = "";
  if (typeof delta.content === "string") {
    contentDelta = delta.content;
  } else if (Array.isArray(delta.content)) {
    contentDelta = delta.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }

  return { reasoningDelta, contentDelta };
}
