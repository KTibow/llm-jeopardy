import type {
  ContestantDefinition,
  ContestantSlotConfig,
  ModelOption,
} from "./game-types";

export function buildContestants(
  slots: ContestantSlotConfig[],
  models: ModelOption[],
): ContestantDefinition[] {
  const modelLookup = new Map(models.map((model) => [model.id, model]));

  return slots
    .filter((slot) => slot.modelId.trim())
    .map((slot) => {
      const matchedModel = modelLookup.get(slot.modelId);
      const fallbackLabel = matchedModel?.name ?? slot.modelId;

      return {
        id: slot.id,
        label: slot.label.trim() || fallbackLabel,
        model: slot.modelId,
      };
    });
}
