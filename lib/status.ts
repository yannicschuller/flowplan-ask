// Whether Flo answers right now, per source: switched on, a key configured,
// and the global limits and the budget leaving room for one more typical
// question (a larger one can still be refused with 429 "budget").
import { config } from "./config";
import { getSettings, type Settings } from "./settings";
import { globalState, typicalCeilingNano } from "./limits";
import { ceilingNano } from "./models";
import { worstPromptBytes } from "./prompt";
import { DOCS_BUDGET_CHARS } from "./docs";
import { now } from "./clock";

// The reserved maximum of a typical question (of the recent ones; without
// any, a prompt with a third of the docs budget and no conversation).
export const typicalNano = (s: Settings) =>
  typicalCeilingNano(s.model, ceilingNano(s.model, worstPromptBytes(Math.round(DOCS_BUDGET_CHARS / 3), 0, s.maxQuestionChars, 0), s.maxTokens));

export function serviceState(settings = getSettings(), at = now()) {
  const g = globalState(settings, typicalNano(settings), at);
  const open = settings.enabled.global && config.anthropicConfigured() && !g.budgetReached && !g.globalReached;
  return {
    docs: open && settings.enabled.docs,
    discord: open && settings.enabled.discord && !!config.botToken(),
    budgetReached: g.budgetReached,
    globalReached: g.globalReached,
    warn: g.warn,
    monthNano: g.monthNano,
    budgetNano: g.budgetNano,
  };
}
