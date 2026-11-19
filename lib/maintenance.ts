// The hourly clean-up (instrumentation.ts): requests that died with the
// process, subjects past the monthly limits' needs, the log's retention
// (README "Privacy"), used challenges and old rate-limit windows.
import { run } from "./db";
import { now } from "./clock";
import { purgeLedger, settleStale } from "./limits";
import { purgeChallenges } from "./session";
import { purgeLog } from "./qalog";
import { getSettings } from "./settings";

export function maintenance(at = now()) {
  settleStale(at);
  purgeLedger(at);
  purgeChallenges(at);
  purgeLog(getSettings(), at);
  run("DELETE FROM rate_limits WHERE window_start < ?", at - 2 * 86_400_000);
}
