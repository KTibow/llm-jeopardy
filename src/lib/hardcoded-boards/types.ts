import type { AnswerKind } from "../game-types";

export interface ArchiveBoardEntry {
  answer: string;
  clue: string;
  answerKind: AnswerKind;
}

export interface ArchiveBoardCategory {
  title: string;
  entries: ArchiveBoardEntry[];
}

export interface ArchiveBoardBlueprint {
  id: string;
  title: string;
  description: string;
  sourceTitle: string;
  sourceUrl: string;
  categories: ArchiveBoardCategory[];
}
