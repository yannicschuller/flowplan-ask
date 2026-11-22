// On every server start: open the database (migrations), load the docs
// index (refreshed every few hours), run the hourly clean-up and look for
// a due insight summary every ten minutes. A failure
// is logged and never keeps the service from starting.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { db } = await import("./lib/db");
    db();
    const { maintenance } = await import("./lib/maintenance");
    const { refreshDocs, REFRESH_MS } = await import("./lib/docs");
    const tick = () => {
      try {
        maintenance();
      } catch (error) {
        console.error("maintenance failed:", error instanceof Error ? error.message : "unknown");
      }
    };
    tick();
    setInterval(tick, 60 * 60 * 1000).unref?.();
    void refreshDocs();
    setInterval(() => void refreshDocs(), REFRESH_MS).unref?.();
    // The insight summaries (lib/insights.ts): a due period is summarised
    // once; the first look a minute after the start.
    const { insightsTick, INSIGHTS_TICK_MS } = await import("./lib/insights");
    setTimeout(() => void insightsTick(), 60_000).unref?.();
    setInterval(() => void insightsTick(), INSIGHTS_TICK_MS).unref?.();
  } catch (error) {
    console.error("Start-up failed:", error instanceof Error ? error.message : "unknown");
  }
}
