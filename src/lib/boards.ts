import { slugify, toCanonicalResponse } from "./format";
import type { BoardCategory, BoardPreset } from "./game-types";
import { show9524Board } from "./hardcoded-boards/show-9524";
import { show9525Board } from "./hardcoded-boards/show-9525";
import { show9526Board } from "./hardcoded-boards/show-9526";
import { show9527Board } from "./hardcoded-boards/show-9527";
import type { ArchiveBoardBlueprint } from "./hardcoded-boards/types";

const VALUES = [200, 400, 600, 800, 1000] as const;

const HARD_CODED_BOARD_BLUEPRINTS: ArchiveBoardBlueprint[] = [
  show9527Board,
  show9526Board,
  show9525Board,
  show9524Board,
];

export const HARD_CODED_BOARDS: BoardPreset[] =
  HARD_CODED_BOARD_BLUEPRINTS.map(createBoardPreset);

export function getHardcodedBoard(boardId: string): BoardCategory[] {
  const preset =
    HARD_CODED_BOARDS.find((candidate) => candidate.id === boardId) ??
    HARD_CODED_BOARDS[0];

  return preset.board.map((category) => ({
    ...category,
    clues: category.clues.map((clue) => ({ ...clue })),
  }));
}

function createBoardPreset(preset: ArchiveBoardBlueprint): BoardPreset {
  return {
    id: preset.id,
    title: preset.title,
    description: preset.description,
    board: preset.categories.map((category, categoryIndex) => ({
      id: `${preset.id}-category-${categoryIndex + 1}`,
      title: category.title,
      clues: category.entries.map((entry, clueIndex) => ({
        id: `${preset.id}-${slugify(category.title)}-${clueIndex + 1}`,
        category: category.title,
        value: VALUES[clueIndex] ?? VALUES[VALUES.length - 1],
        clue: entry.clue,
        answer: entry.answer,
        canonicalResponse: toCanonicalResponse(entry.answerKind, entry.answer),
        answerKind: entry.answerKind,
        sourceTitle: preset.sourceTitle,
        sourceUrl: preset.sourceUrl,
        description: `${preset.description} Category: ${category.title}.`,
      })),
    })),
  };
}
