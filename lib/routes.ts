// The logic of every public endpoint, on plain Request and Response
// (app/api/** only forwards here; tests call these directly). Each public
// answer – errors included – carries the CORS headers for allowed origins.
import { handle, clientIp, json, readJson, HttpError } from "./http";
import { LIMITS, ipKey, limit } from "./rate-limit";
import { newChallenge, solveChallenge } from "./session";
import { serviceState } from "./status";
import { askRoute } from "./ask";
import { preflight, requireAllowedOrigin, withCors } from "./cors";
import { one } from "./db";

export { adminRoute } from "./admin";
export { botRoute } from "./bot";

// handle() plus CORS, for the public API.
export async function publicRoute(request: Request, fn: () => Promise<Response> | Response) {
  return withCors(request, await handle(fn));
}
export const optionsRoute = (request: Request, methods: string) => preflight(request, methods);

export function healthRoute() {
  one("SELECT 1");
  return json({ service: "flowplan-ask", status: "ok" });
}

// GET /api/status: no secrets, no numbers.
export function statusRoute() {
  const s = serviceState();
  return json({ docs: s.docs, discord: s.discord, name: "Flo" }, { headers: { "Cache-Control": "public, max-age=60" } });
}

// POST /api/session: {} → a challenge; { challenge, nonce } → a session token.
export async function sessionRoute(request: Request) {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  requireAllowedOrigin(request);
  const body = await readJson(request, 2048, true);
  const key = ipKey(clientIp(request));
  if (body.challenge === undefined && body.nonce === undefined) {
    limit(`challenge:${key}`, LIMITS.challenge);
    return json(newChallenge());
  }
  limit(`session:${key}`, LIMITS.session);
  return json(solveChallenge(body.challenge, body.nonce));
}

export { askRoute };
