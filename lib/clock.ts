// The current time, replaceable in tests (limits by minute, day and month).
// Days and months are UTC calendar days and months.
export const clock = { now: () => Date.now() };
export const now = () => clock.now();

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);
export const monthKey = (at: number) => new Date(at).toISOString().slice(0, 7);
export const startOfDay = (at: number) => Math.floor(at / DAY) * DAY;
export const nextDay = (at: number) => startOfDay(at) + DAY;
export function startOfMonth(at: number) {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function nextMonth(at: number) {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
