import type { AnswerKind } from "./game-types";

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
export function stripParenthetical(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function normalizeTriviaResponse(value: string | null | undefined): string {
  let text = (value ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  // Strip Jeopardy phrasing
  text = text.replace(/^(WHAT|WHO|WHERE|WHEN|WHY|HOW)\s+(IS|ARE|WAS|WERE|DO|DID|DOES)\s+/, "");

  // Strip leading articles (The, A, An)
  text = text.replace(/^(THE|A|AN)\s+/, "");

  return text.trim();
}
export function toCanonicalResponse(answerKind: AnswerKind, answer: string): string {
  const pronoun = answerKind === "who" ? "Who" : "What";
  return `${pronoun} is ${answer}?`;
}
