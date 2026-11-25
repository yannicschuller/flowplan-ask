// The status of Flowplan's own hosted services (status.flowplan.org) as one
// more data block in the prompt (README "Status of the hosted services").
// The service fetches it – never the model, which has no tools: the status
// page is static, a GitHub Action of flowplan-status writes summary.json
// every 5 minutes (state per service, open incidents, maintenance) and
// services.json holds the groups and names. Both are public files; the
// requests carry nothing about the person asking (no question, no
// subject, no address). Cached in memory – summary.json for 2 minutes,
// services.json for an hour – with short timeouts; when they can't be read
// the block says so and the question is answered all the same.
import { STATUS_PAGE, config } from "./config";
import type { Settings } from "./settings";
import { now } from "./clock";

export const SUMMARY_TTL = 2 * 60_000;
export const SERVICES_TTL = 60 * 60_000;
// After a failed fetch the next try waits this long (meanwhile the last good
// data, or "could not be read"), so an unreachable host doesn't slow down
// every question by the timeout.
export const RETRY_AFTER = 30_000;
export const TIMEOUT_MS = 3000;
// The check runs every 5 minutes; older data counts as "no data".
export const STALE_AFTER = 30 * 60_000;
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_SERVICES_BYTES = 256 * 1024;
// The block's upper bound (README; part of the reserved worst case).
export const STATUS_MAX_CHARS = 1800;

export type HostedState = "up" | "slow" | "outage" | "maintenance" | "no data";
const STATES: Record<string, HostedState> = { up: "up", degraded: "slow", down: "outage", maintenance: "maintenance" };

type Group = { name: string; services: { id: string; name: string }[] };
type Summary = {
  updatedAt: number | null;
  services: Record<string, string>;
  incidents: { service: string; status: string; since: number | null; title: string }[];
  maintenance: { title: string; start: number | null; end: number | null; services: string[] }[];
};
type Cached<T> = { url: string; value: T | null; at: number; failedAt: number; pending: Promise<void> | null };

const holder = globalThis as unknown as { askStatus?: { summary: Cached<Summary>; groups: Cached<Group[]> } };
const fresh = <T>(url: string): Cached<T> => ({ url, value: null, at: 0, failedAt: 0, pending: null });
function caches(summaryUrl: string, servicesUrl: string) {
  holder.askStatus ??= { summary: fresh(summaryUrl), groups: fresh(servicesUrl) };
  if (holder.askStatus.summary.url !== summaryUrl) holder.askStatus.summary = fresh(summaryUrl);
  if (holder.askStatus.groups.url !== servicesUrl) holder.askStatus.groups = fresh(servicesUrl);
  return holder.askStatus;
}
export const forgetHostedStatus = () => {
  holder.askStatus = undefined;
};

// One short line of text from the status data: no control characters or
// angle brackets (it is data inside a block), bounded.
const line = (v: unknown, max = 80) =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, " ")
        .replace(/</g, "‹")
        .replace(/>/g, "›")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
// A name or title: a string or { en, de }.
const named = (v: unknown, max = 80) => line(v && typeof v === "object" ? ((v as Record<string, unknown>).en ?? (v as Record<string, unknown>).de) : v, max);
const time = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseServices(json: unknown): Group[] {
  return list(obj(json).groups)
    .slice(0, 20)
    .map((g) => ({
      name: named(obj(g).name) || line(obj(g).id) || "Services",
      services: list(obj(g).services)
        .slice(0, 40)
        .map((x) => ({ id: String(obj(x).id ?? ""), name: named(obj(x).name) || line(obj(x).id) }))
        .filter((x) => ID.test(x.id)),
    }))
    .filter((g) => g.services.length);
}

export function parseSummary(json: unknown): Summary {
  const o = obj(json);
  const services: Record<string, string> = {};
  for (const [id, v] of Object.entries(obj(o.services)).slice(0, 100)) {
    // summary.json: { id: "up" }; the full status.json: { id: { status } }.
    const st = typeof v === "string" ? v : obj(v).status;
    if (ID.test(id) && typeof st === "string") services[id] = st;
  }
  return {
    updatedAt: time(o.updatedAt),
    services,
    incidents: list(o.incidents)
      .slice(0, 20)
      .map((i) => ({ service: String(obj(i).service ?? ""), status: line(obj(i).status, 20), since: time(obj(i).since ?? obj(i).start), title: named(obj(i).title, 120) })),
    maintenance: list(o.maintenance)
      .slice(0, 10)
      .map((m) => ({
        title: named(obj(m).title, 120),
        start: time(obj(m).start),
        end: time(obj(m).end),
        services: list(obj(m).services).filter((x): x is string => typeof x === "string" && ID.test(x)),
      })),
  };
}

async function getJson(url: string, maxBytes: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "cache-control": "no-cache", "user-agent": "flowplan-ask (status)" },
    redirect: "follow",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.url && new URL(res.url).origin !== new URL(url).origin) throw new Error("redirected to another origin");
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("too large");
  return JSON.parse(text);
}

// Fresh enough → as it is; else one fetch at a time (concurrent questions wait
// for the same one), and after a failure not again for RETRY_AFTER.
async function load<T>(c: Cached<T>, ttl: number, maxBytes: number, parse: (json: unknown) => T, what: string) {
  const at = now();
  if (c.value && at - c.at < ttl) return;
  if (c.failedAt && at - c.failedAt < RETRY_AFTER) return;
  c.pending ??= getJson(c.url, maxBytes)
    .then((json) => {
      c.value = parse(json);
      c.at = now();
      c.failedAt = 0;
    })
    .catch((error: unknown) => {
      c.failedAt = now();
      // The address is the maintainer's setting – never anything personal.
      console.error(`status: ${what} could not be read (${error instanceof Error ? error.name === "TimeoutError" ? "timeout" : error.message.slice(0, 80) : "error"})`);
    })
    .finally(() => {
      c.pending = null;
    });
  await c.pending;
}

export type HostedStatus =
  | { ok: false }
  | {
      ok: true;
      checkedAt: number | null;
      groups: { name: string; services: { id: string; name: string; state: HostedState }[] }[];
      incidents: string[];
      maintenance: string[];
      // Whether anything is not "up" (or an incident or maintenance is going on).
      notice: boolean;
    };

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// The current status, from the cache or fetched; null when switched off.
export async function hostedStatus(settings: Settings): Promise<HostedStatus | null> {
  if (!settings.status.enabled) return null;
  const c = caches(settings.status.summaryUrl || config.statusSummaryUrl(), settings.status.servicesUrl || config.statusServicesUrl());
  await Promise.all([
    load(c.summary, SUMMARY_TTL, MAX_SUMMARY_BYTES, parseSummary, "summary.json"),
    load(c.groups, SERVICES_TTL, MAX_SERVICES_BYTES, parseServices, "services.json"),
  ]);
  const summary = c.summary.value;
  // Kept data older than the check's staleness is no better than none.
  if (!summary || now() - c.summary.at > STALE_AFTER) return { ok: false };
  const at = now();
  const stale = summary.updatedAt === null || at - summary.updatedAt > STALE_AFTER;
  // Without services.json: the ids of summary.json in one group.
  const groups: Group[] = c.groups.value?.length
    ? c.groups.value
    : [{ name: "Services", services: Object.keys(summary.services).map((id) => ({ id, name: id })) }];
  const nameOf = new Map(groups.flatMap((g) => g.services.map((x) => [x.id, x.name] as const)));
  const out = groups.map((g) => ({
    name: g.name,
    services: g.services.map((x) => ({ id: x.id, name: x.name, state: (stale ? "no data" : STATES[summary.services[x.id]] ?? "no data") as HostedState })),
  }));
  const incidents = stale
    ? []
    : summary.incidents
        .filter((i) => ID.test(i.service))
        .slice(0, 5)
        .map((i) => {
          const name = nameOf.get(i.service) ?? i.service;
          const state = STATES[i.status] ?? "outage";
          return `${name}: ${i.title ? `"${i.title}", ` : ""}${state}${i.since ? ` since ${utc(i.since)}` : ""}`;
        });
  const upcoming = summary.maintenance.filter((m) => m.end !== null && m.end > at && (m.start === null || m.start - at < 7 * 86_400_000)).slice(0, 3);
  const maintenance = upcoming.map((m) => {
    const which = m.services.length ? m.services.map((id) => nameOf.get(id) ?? id).join(", ") : "all services";
    const when = m.start !== null && m.start <= at ? `now, until ${utc(m.end!)}` : `${m.start !== null ? utc(m.start) : "?"} to ${utc(m.end!)}`;
    return `${m.title ? `"${m.title}" – ` : ""}${which}, ${when}`;
  });
  const notice =
    incidents.length > 0 || upcoming.some((m) => m.start === null || m.start <= at) || out.some((g) => g.services.some((x) => x.state !== "up"));
  return { ok: true, checkedAt: summary.updatedAt, groups: out, incidents, maintenance, notice };
}

// Questions where the status may matter: connections, outages, slowness,
// the status itself – in German, English and French.
const RELEVANT = new RegExp(
  "(?<![\\p{L}\\p{N}])(?:" +
    [
      // English
      "down", "offline", "outages?", "status", "slow\\w*", "lag\\w*", "unreachable", "unavailable", "not (?:loading|working|responding)",
      "can'?t (?:connect|reach|load|log ?in|sign ?in)", "connect\\w*", "server\\w*", "sync\\w*", "time ?outs?", "timed out", "maintenance", "incidents?",
      "50[0234]", "bad gateway", "app\\.flowplan\\.org", "hosted", "cloud",
      // German
      "erreichbar\\w*", "verbind\\w*", "störung\\w*", "stoerung\\w*", "ausfall\\w*", "ausgefallen", "fällt aus", "langsam\\w*", "wartung\\w*", "lädt nicht",
      "geht nicht", "funktioniert nicht", "hängt", "synchronisier\\w*",
      // French
      "panne\\w*", "hors ligne", "connexion\\w*", "connect[ée]\\w*", "serveur\\w*", "lent\\w*", "lenteur\\w*", "statut", "indisponible\\w*",
      "inaccessible\\w*", "coupure\\w*", "ne (?:marche|fonctionne|charge) pas", "synchronis\\w*",
    ].join("|") +
    ")(?![\\p{L}\\p{N}])",
  "iu",
);
export const statusRelevant = (text: string) => RELEVANT.test(text);

// Whether the block goes into this prompt: when the question (or the
// previous one) is about connections, outages or the status, or when a
// hosted service is not up right now – then any question may be about it.
// Otherwise it is left out (about 100–150 tokens saved per question).
export function includeStatus(status: HostedStatus | null, text: string) {
  if (!status) return false;
  return statusRelevant(text) || (status.ok && status.notice);
}

// The data block (lib/prompt.ts puts it into the user turn).
export function statusBlock(status: HostedStatus): string {
  if (!status.ok)
    return [
      "<hosted_status>",
      `The current status of Flowplan's hosted services could not be read. Status page: ${STATUS_PAGE}`,
      "</hosted_status>",
    ].join("\n");
  const checked = status.checkedAt === null ? "unknown time" : utc(status.checkedAt);
  const lines = [
    `<hosted_status checked="${checked}" page="${STATUS_PAGE}">`,
    `Current status of Flowplan's hosted services (status.flowplan.org), checked ${checked}:`,
    ...status.groups.map((g) => `- ${g.name}: ${g.services.map((x) => `${x.name} ${x.state}`).join("; ")}`),
    ...status.incidents.map((i) => `Ongoing incident: ${i}`),
    ...status.maintenance.map((m) => `Maintenance: ${m}`),
  ];
  let text = lines.join("\n");
  while (text.length > STATUS_MAX_CHARS - 20 && lines.length > 3) {
    lines.splice(lines.length - 1, 1);
    text = lines.join("\n");
  }
  return `${text.slice(0, STATUS_MAX_CHARS - 20)}\n</hosted_status>`;
}
