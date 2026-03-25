import { APP_TITLE, OPENROUTER_BASE_URL } from "./app-config";
import type { GatewayConfig, ModelOption } from "./game-types";

const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_AUTH_KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
const PKCE_STORAGE_KEY = "llm-jeopardy.openrouter.pkce.v1";
const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const MODELS_SUFFIX = "/models";

interface OpenRouterPkceState {
  codeVerifier: string;
  codeChallengeMethod: "S256";
}

export function normalizeGatewayBaseUrl(value: string): string {
  let normalized = value.trim().replace(/\/+$/, "");

  if (normalized.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    normalized = normalized.slice(0, -CHAT_COMPLETIONS_SUFFIX.length);
  }

  if (normalized.endsWith(MODELS_SUFFIX)) {
    normalized = normalized.slice(0, -MODELS_SUFFIX.length);
  }

  return normalized;
}

export function isOpenRouterBaseUrl(value: string): boolean {
  return normalizeGatewayBaseUrl(value) === OPENROUTER_BASE_URL;
}

export function getModelsUrl(baseUrl: string): string {
  return `${normalizeGatewayBaseUrl(baseUrl)}${MODELS_SUFFIX}`;
}

export function getChatCompletionsUrl(baseUrl: string): string {
  return `${normalizeGatewayBaseUrl(baseUrl)}${CHAT_COMPLETIONS_SUFFIX}`;
}

export async function fetchGatewayModels(
  gateway: GatewayConfig,
): Promise<ModelOption[]> {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(gateway.baseUrl);
  const url = getModelsUrl(gateway.baseUrl);
  const headers: Record<string, string> = {};

  if (gateway.apiKey.trim()) {
    headers.Authorization = `Bearer ${gateway.apiKey.trim()}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Model listing failed with ${response.status}`);
  }

  const payload = (await response.json()) as
    | { data?: unknown[]; models?: unknown[] }
    | unknown[];

  const rawModels = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];

  const normalized = rawModels
    .map(normalizeModelOption)
    .filter((model): model is ModelOption => Boolean(model));

  const unique = new Map<string, ModelOption>();
  for (const model of normalized) {
    unique.set(model.id, model);
  }

  return Array.from(unique.values()).sort((left, right) =>
    compareModels(left, right, isOpenRouterBaseUrl(normalizedBaseUrl)),
  );
}

export async function beginOpenRouterOAuth() {
  const state = await createPkceState();
  window.localStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(state));

  const callbackUrl = getOAuthCallbackUrl();
  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: state.codeChallenge,
    code_challenge_method: state.codeChallengeMethod,
  });

  window.location.assign(`${OPENROUTER_AUTH_URL}?${params.toString()}`);
}

export async function exchangeOpenRouterCodeForKey(code: string): Promise<string> {
  const pkceState = loadPkceState();
  if (!pkceState) {
    throw new Error("Missing saved OpenRouter PKCE state");
  }

  const response = await fetch(OPENROUTER_AUTH_KEYS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      code_verifier: pkceState.codeVerifier,
      code_challenge_method: pkceState.codeChallengeMethod,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter auth exchange failed with ${response.status}`);
  }

  const payload = (await response.json()) as { key?: string };
  if (!payload.key) {
    throw new Error("OpenRouter auth exchange did not return a key");
  }

  window.localStorage.removeItem(PKCE_STORAGE_KEY);
  return payload.key;
}

export function clearOAuthCodeFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  window.history.replaceState({}, document.title, url.toString());
}

export function getOpenRouterHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": window.location.href,
    "X-Title": APP_TITLE,
  };
}

function normalizeModelOption(input: unknown): ModelOption | null {
  if (typeof input === "string" && input.trim()) {
    return {
      id: input,
      name: input,
    };
  }

  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const pricing =
    candidate.pricing && typeof candidate.pricing === "object"
      ? (candidate.pricing as Record<string, unknown>)
      : null;
  const promptPrice = parsePrice(pricing?.prompt);
  const completionPrice = parsePrice(pricing?.completion);
  const requestPrice = parsePrice(pricing?.request);
  const internalReasoningPrice = parsePrice(pricing?.internal_reasoning);

  const id =
    typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id
      : typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name
        : null;

  if (!id) {
    return null;
  }

  return {
    id,
    name:
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name
        : id,
    contextLength:
      typeof candidate.context_length === "number"
        ? candidate.context_length
        : typeof candidate.contextLength === "number"
          ? candidate.contextLength
          : null,
    description:
      typeof candidate.description === "string" ? candidate.description : null,
    promptPrice,
    completionPrice,
    requestPrice,
    internalReasoningPrice,
    sortPrice: getSortPrice({
      promptPrice,
      completionPrice,
      requestPrice,
      internalReasoningPrice,
    }),
  };
}

function compareModels(
  left: ModelOption,
  right: ModelOption,
  priceFirst: boolean,
): number {
  if (priceFirst) {
    const leftPrice = left.sortPrice ?? Number.POSITIVE_INFINITY;
    const rightPrice = right.sortPrice ?? Number.POSITIVE_INFINITY;

    if (leftPrice !== rightPrice) {
      return leftPrice - rightPrice;
    }
  }

  return left.name.localeCompare(right.name);
}

function parsePrice(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }

  if (typeof input === "string" && input.trim()) {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getSortPrice({
  promptPrice,
  completionPrice,
  requestPrice,
  internalReasoningPrice,
}: Pick<
  ModelOption,
  "promptPrice" | "completionPrice" | "requestPrice" | "internalReasoningPrice"
>): number | null {
  const values = [
    promptPrice,
    completionPrice,
    requestPrice,
    internalReasoningPrice,
  ].filter((value): value is number => value !== null && value !== undefined);

  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0);
}

async function createPkceState(): Promise<
  OpenRouterPkceState & { codeChallenge: string }
> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  const codeVerifier = base64UrlEncode(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );

  return {
    codeVerifier,
    codeChallenge: base64UrlEncode(new Uint8Array(digest)),
    codeChallengeMethod: "S256",
  };
}

function loadPkceState(): OpenRouterPkceState | null {
  try {
    const raw = window.localStorage.getItem(PKCE_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<OpenRouterPkceState>;
    if (
      typeof parsed.codeVerifier !== "string" ||
      parsed.codeChallengeMethod !== "S256"
    ) {
      return null;
    }

    return {
      codeVerifier: parsed.codeVerifier,
      codeChallengeMethod: parsed.codeChallengeMethod,
    };
  } catch {
    return null;
  }
}

function getOAuthCallbackUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

function base64UrlEncode(input: Uint8Array): string {
  let output = "";
  for (const byte of input) {
    output += String.fromCharCode(byte);
  }

  return btoa(output).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
