// "instant"/"medium"/"high" are the current composer's effort labels; older
// tier names stay valid input aliases but cannot be selected on this layout.
const CHATGPT_EFFORT_CHOICES = [
  "light",
  "standard",
  "extended",
  "heavy",
  "pro",
  "instant",
  "medium",
  "high",
];

// The Plus composer exposes one pill whose text is exactly the current effort.
function isPlusComposerEffortPillLabel(value) {
  const normalized = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  return ["instant", "medium", "high"].includes(normalized);
}

// Advanced submenu rows concatenate label and value ("ModelGPT-5.6 Sol"), so
// prefix matching must not rely on word boundaries.
function plusMenuRowKind(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (/^model/i.test(text)) return "model";
  if (/^effort/i.test(text)) return "effort";
  return null;
}

function plusMenuRowCurrentValue(value, kind) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return kind === "model" ? text.replace(/^model/i, "").trim() : text.replace(/^effort/i, "").trim();
}
const CHATGPT_MODEL_ALIASES = new Map([
  ["instant", "instant"],
  ["gpt53", "instant"],
  ["thinking", "thinking"],
  ["gpt54thinking", "thinking"],
  ["pro", "pro"],
  ["gpt54pro", "pro"],
  ["55", "gpt55"],
  ["gpt55", "gpt55"],
  ["chatgpt55", "gpt55"],
  ["56sol", "gpt56sol"],
  ["gpt56sol", "gpt56sol"],
  ["chatgpt56sol", "gpt56sol"],
]);

function normalizeChatGPTModelChoice(desiredModel) {
  const normalized = String(desiredModel || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  return CHATGPT_MODEL_ALIASES.get(normalized) || normalized;
}

function normalizeChatGPTEffortChoice(desiredEffort) {
  const normalized = String(desiredEffort || "").toLowerCase().trim();
  return CHATGPT_EFFORT_CHOICES.includes(normalized) ? normalized : null;
}

function normalizedWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function modelCandidateMatches(item, targetModel) {
  const values = [item?.label, item?.testId?.replace(/^model-switcher-/, "")].filter(Boolean);
  return values.some((value) => {
    const normalizedValue = normalizeChatGPTModelChoice(value);
    if (normalizedValue === targetModel) return true;
    if (targetModel.startsWith("gpt") && normalizedValue.includes(targetModel)) return true;
    const variants = ["instant", "thinking", "pro"].filter((variant) =>
      normalizedWords(value).includes(variant),
    );
    return variants.length === 1 && variants[0] === targetModel;
  });
}

function effortCandidateMatches(item, targetEffort) {
  // Plus radios concatenate the group prefix onto their value ("EffortHigh"),
  // so strip it before extracting effort words; Pro-era labels are untouched.
  const rawLabel = String(item?.label || "");
  const stripped = rawLabel.replace(/^effort/i, "").trim();
  const label = stripped || rawLabel;
  const labelVariants = new Set(
    normalizedWords(label).filter((word) => CHATGPT_EFFORT_CHOICES.includes(word)),
  );
  if (labelVariants.size > 0) {
    return labelVariants.size === 1 && labelVariants.has(targetEffort);
  }
  const testIdVariants = new Set(
    normalizedWords(item?.testId).filter((word) => CHATGPT_EFFORT_CHOICES.includes(word)),
  );
  return testIdVariants.size === 1 && testIdVariants.has(targetEffort);
}

function uniqueMatch(items, matches) {
  if (!Array.isArray(items)) return null;
  const candidates = items.filter(matches);
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveChatGPTModelMenuOption(items, desiredModel) {
  const targetModel = normalizeChatGPTModelChoice(desiredModel);
  if (!targetModel) return null;
  return uniqueMatch(
    items,
    (item) =>
      ["button", "menuitem", "menuitemradio", "radio"].includes(item?.role) &&
      modelCandidateMatches(item, targetModel),
  );
}

function verifyChatGPTModelSelection(items, desiredModel) {
  const targetModel = normalizeChatGPTModelChoice(desiredModel);
  if (!targetModel) return null;
  return uniqueMatch(
    items,
    (item) =>
      (typeof item?.label === "string" || typeof item?.testId === "string") &&
      modelCandidateMatches(item, targetModel),
  );
}

function resolveChatGPTEffortMenuOption(items, desiredEffort) {
  const targetEffort = normalizeChatGPTEffortChoice(desiredEffort);
  if (!targetEffort) return null;
  return uniqueMatch(
    items,
    (item) =>
      ["button", "menuitem", "menuitemradio"].includes(item?.role) &&
      effortCandidateMatches(item, targetEffort),
  );
}

function verifyChatGPTEffortSelection(items, desiredEffort) {
  const targetEffort = normalizeChatGPTEffortChoice(desiredEffort);
  if (!targetEffort) return null;
  return uniqueMatch(
    items,
    (item) =>
      (typeof item?.label === "string" || typeof item?.testId === "string") &&
      effortCandidateMatches(item, targetEffort),
  );
}

function boundedOptionLabels(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => String(item?.label || "").replace(/\s+/g, " ").trim().slice(0, 80))
    .filter(Boolean)
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .slice(0, 10);
}

module.exports = {
  CHATGPT_EFFORT_CHOICES,
  boundedOptionLabels,
  effortCandidateMatches,
  isPlusComposerEffortPillLabel,
  modelCandidateMatches,
  normalizeChatGPTEffortChoice,
  normalizeChatGPTModelChoice,
  plusMenuRowCurrentValue,
  plusMenuRowKind,
  resolveChatGPTEffortMenuOption,
  resolveChatGPTModelMenuOption,
  verifyChatGPTEffortSelection,
  verifyChatGPTModelSelection,
};
