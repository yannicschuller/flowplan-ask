// The settings flowplan-admin edits (README "Admin API"): one JSON object in
// the database, validated field by field. A PUT may leave fields out (they
// keep their value); unknown fields are ignored; a value out of range
// rejects the whole PUT with the list of problems.
import { one, run } from "./db";
import { HttpError } from "./http";
import { DEFAULT_MODEL, MODELS, isModel, type ModelId } from "./models";
import { now } from "./clock";
import { config } from "./config";

export type SubjectLimits = { perMinute: number; perHour: number; perDay: number; perMonth: number; costPerDayUsd: number; costPerMonthUsd: number };
export type GlobalLimits = { perDay: number; perMonth: number; costPerDayUsd: number; costPerMonthUsd: number };
export type Settings = {
  enabled: { global: boolean; docs: boolean; discord: boolean };
  model: ModelId;
  maxTokens: number;
  maxQuestionChars: number;
  maxTurns: number;
  maxConversationChars: number;
  limits: { subject: SubjectLimits; global: GlobalLimits };
  monthlyBudgetUsd: number;
  warnAtPercent: number;
  discord: { channelIds: string[]; roleIds: string[]; onLimit: "message" | "readonly" };
  logging: { enabled: boolean; retentionDays: number };
  // The regular summary of the Q&A log (lib/insights.ts): how often, and its own model.
  insights: { interval: InsightsInterval; model: ModelId };
  // Report drafts for Discord (lib/draft.ts): whether Flo offers them, the
  // draft call's max_tokens and how many drafts one person may have per day.
  reports: { enabled: boolean; maxTokens: number; perDay: number };
};
export type InsightsInterval = "off" | "daily" | "weekly";
export const INSIGHTS_INTERVALS: InsightsInterval[] = ["off", "daily", "weekly"];

export const DEFAULT_SETTINGS: Settings = {
  enabled: { global: true, docs: true, discord: true },
  model: DEFAULT_MODEL,
  maxTokens: 1000,
  maxQuestionChars: 2000,
  maxTurns: 6,
  maxConversationChars: 4000,
  limits: {
    subject: { perMinute: 3, perHour: 20, perDay: 40, perMonth: 300, costPerDayUsd: 0.25, costPerMonthUsd: 2 },
    global: { perDay: 2000, perMonth: 20000, costPerDayUsd: 5, costPerMonthUsd: 50 },
  },
  monthlyBudgetUsd: 20,
  warnAtPercent: 80,
  discord: { channelIds: [], roleIds: [], onLimit: "message" },
  logging: { enabled: false, retentionDays: 30 },
  insights: { interval: "daily", model: DEFAULT_MODEL },
  reports: { enabled: true, maxTokens: 1500, perDay: 5 },
};

// Ranges (the same as flowplan-admin's form). Every count and cost limit
// is on (≥ 1 question, ≥ 0.01 USD); a monthly budget of 0 stops every
// question. Cross-field rules: see CHECKS.
const COUNT = { min: 1, max: 10_000_000, int: true };
const COST = { min: 0.01, max: 10_000, int: false };
type Range = { min: number; max: number; int: boolean };
const RANGES: Record<string, Range> = {
  maxTokens: { min: 100, max: 4000, int: true },
  maxQuestionChars: { min: 50, max: 4000, int: true },
  // History entries (a question or an answer each).
  maxTurns: { min: 0, max: 20, int: true },
  maxConversationChars: { min: 500, max: 50_000, int: true },
  monthlyBudgetUsd: { min: 0, max: 10_000, int: false },
  warnAtPercent: { min: 1, max: 100, int: true },
  "limits.subject.perMinute": COUNT,
  "limits.subject.perHour": COUNT,
  "limits.subject.perDay": COUNT,
  "limits.subject.perMonth": COUNT,
  "limits.subject.costPerDayUsd": COST,
  "limits.subject.costPerMonthUsd": COST,
  "limits.global.perDay": COUNT,
  "limits.global.perMonth": COUNT,
  "limits.global.costPerDayUsd": COST,
  "limits.global.costPerMonthUsd": COST,
  "logging.retentionDays": { min: 1, max: 365, int: true },
  "reports.maxTokens": { min: 500, max: 4000, int: true },
  "reports.perDay": { min: 1, max: 100, int: true },
};
// [smaller, larger]: the first must not exceed the second (on the merged result).
const CHECKS: [string, string][] = [
  ["maxQuestionChars", "maxConversationChars"],
  ["limits.subject.perMinute", "limits.subject.perHour"],
  ["limits.subject.perHour", "limits.subject.perDay"],
  ["limits.subject.perDay", "limits.subject.perMonth"],
  ["limits.subject.costPerDayUsd", "limits.subject.costPerMonthUsd"],
  ["limits.global.perDay", "limits.global.perMonth"],
  ["limits.global.costPerDayUsd", "limits.global.costPerMonthUsd"],
];
const BOOLEANS = ["enabled.global", "enabled.docs", "enabled.discord", "logging.enabled", "reports.enabled"];
const ID_LISTS = ["discord.channelIds", "discord.roleIds"];
const MAX_IDS = 50;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);
function set(o: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let x = o;
  for (const k of keys.slice(0, -1)) x = x[k] as Record<string, unknown>;
  x[keys[keys.length - 1]] = value;
}

// Applies `input` (possibly partial) onto `base`; throws 400 with every problem.
export function mergeSettings(base: Settings, input: unknown): Settings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "invalid_settings", "settings must be an object.", { errors: ["settings: object"] });
  const out = clone(base) as unknown as Record<string, unknown>;
  const errors: string[] = [];
  for (const [path, r] of Object.entries(RANGES)) {
    const v = get(input, path);
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < r.min || v > r.max || (r.int && !Number.isInteger(v)))
      errors.push(`${path}: ${r.int ? "integer" : "number"} ${r.min}–${r.max}`);
    else set(out, path, r.int ? v : Math.round(v * 1e6) / 1e6);
  }
  for (const path of BOOLEANS) {
    const v = get(input, path);
    if (v === undefined) continue;
    if (typeof v !== "boolean") errors.push(`${path}: boolean`);
    else set(out, path, v);
  }
  for (const path of ID_LISTS) {
    const v = get(input, path);
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > MAX_IDS || !v.every((id) => typeof id === "string" && /^\d{17,20}$/.test(id)))
      errors.push(`${path}: at most ${MAX_IDS} Discord ids (17–20 digits)`);
    else set(out, path, [...new Set(v as string[])]);
  }
  const model = get(input, "model");
  if (model !== undefined) {
    if (!isModel(model)) errors.push(`model: one of ${Object.keys(MODELS).join(", ")}`);
    else out.model = model;
  }
  const insightsModel = get(input, "insights.model");
  if (insightsModel !== undefined) {
    if (!isModel(insightsModel)) errors.push(`insights.model: one of ${Object.keys(MODELS).join(", ")}`);
    else set(out, "insights.model", insightsModel);
  }
  const interval = get(input, "insights.interval");
  if (interval !== undefined) {
    if (!INSIGHTS_INTERVALS.includes(interval as InsightsInterval)) errors.push(`insights.interval: ${INSIGHTS_INTERVALS.join(", ")}`);
    else set(out, "insights.interval", interval);
  }
  const onLimit = get(input, "discord.onLimit");
  if (onLimit !== undefined) {
    if (onLimit !== "message" && onLimit !== "readonly") errors.push("discord.onLimit: message or readonly");
    else set(out, "discord.onLimit", onLimit);
  }
  if (!errors.length)
    for (const [small, large] of CHECKS) if ((get(out, small) as number) > (get(out, large) as number)) errors.push(`${small}: at most ${large}`);
  if (errors.length) throw new HttpError(400, "invalid_settings", "Invalid settings.", { errors });
  return out as unknown as Settings;
}

const holder = globalThis as unknown as { askSettings?: { at: number; dir: string; value: Settings } };

// The stored settings over the defaults (fields added later get their default).
export function getSettings(): Settings {
  const cached = holder.askSettings;
  if (cached && cached.dir === config.dataDir() && Math.abs(now() - cached.at) < 2000) return clone(cached.value);
  const row = one<{ json: string }>("SELECT json FROM settings WHERE id=1");
  let value = DEFAULT_SETTINGS;
  if (row) {
    try {
      value = mergeSettings(DEFAULT_SETTINGS, JSON.parse(row.json));
    } catch {
      console.error("Stored settings are invalid – using the defaults.");
    }
  }
  holder.askSettings = { at: now(), dir: config.dataDir(), value };
  return clone(value);
}

export function saveSettings(input: unknown, actor: string): Settings {
  const value = mergeSettings(getSettings(), input);
  run(
    "INSERT INTO settings(id,json,updated_at,actor) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at,actor=excluded.actor",
    JSON.stringify(value),
    now(),
    actor.slice(0, 100),
  );
  holder.askSettings = undefined;
  return getSettings();
}
export const forgetSettings = () => {
  holder.askSettings = undefined;
};
