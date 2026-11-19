// CORS for the public API: only the allowed origins (ASK_ALLOWED_ORIGINS,
// default https://docs.flowplan.org) get Access-Control-Allow-Origin; no
// credentials (there are no cookies). A browser request from any other
// origin is refused outright. The admin API sends no CORS headers at all.
import { config } from "./config";
import { HttpError } from "./http";

export function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  return origin && config.allowedOrigins().has(origin) ? origin : null;
}

// A request that carries an Origin header must come from an allowed one.
export function requireAllowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigin(request)) throw new HttpError(403, "cross_origin", "Origin not allowed.");
}

export function withCors(request: Request, response: Response) {
  const origin = allowedOrigin(request);
  const headers = new Headers(response.headers);
  headers.append("Vary", "Origin");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Retry-After");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// OPTIONS: the preflight.
export function preflight(request: Request, methods: string) {
  const origin = allowedOrigin(request);
  if (!origin) return new Response(null, { status: 403, headers: { Vary: "Origin", "Cache-Control": "no-store" } });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "Content-Type, X-Ask-Session",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}
