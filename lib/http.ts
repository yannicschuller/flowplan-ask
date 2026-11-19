// Small helpers for route handlers on the standard Request and Response, so
// the handlers can be tested without Next.js.
import { LimitError } from "./rate-limit";
import { now } from "./clock";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...init.headers },
  });
}

// Runs a handler and turns known errors into JSON answers. Unknown errors
// are logged without their details reaching the client.
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message, ...error.extra }, { status: error.status });
    if (error instanceof LimitError) {
      const seconds = Math.max(1, Math.ceil((error.retryAt - now()) / 1000));
      return json(
        { error: "limit", scope: error.scope, retryAt: new Date(error.retryAt).toISOString() },
        { status: 429, headers: { "Retry-After": String(Math.min(seconds, 31 * 86_400)) } },
      );
    }
    console.error("internal error:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
    return json({ error: "internal", message: "Internal error." }, { status: 500 });
  }
}

// The client's address, only ever used through ipKey() (hashed, rotating
// daily): the first hop of X-Forwarded-For (Coolify's proxy sets it), else
// X-Real-IP. Never stored, never sent anywhere.
export function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim().slice(0, 64);
  return request.headers.get("x-real-ip")?.trim().slice(0, 64) || "unknown";
}

// The body, at most `limit` bytes (also when Content-Length lies).
export async function readBody(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new HttpError(413, "too_large", "Request too large.");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "Request too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// A JSON object body (Content-Type application/json, which also makes every
// cross-origin browser request a preflighted one).
export async function readJson(request: Request, limit: number, allowEmpty = false): Promise<Record<string, unknown>> {
  const raw = (await readBody(request, limit)).toString("utf8");
  if (!raw.trim() && allowEmpty) return {};
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON body.");
  }
}

// A Bearer token from the Authorization header ("" when there is none).
export function bearer(request: Request) {
  const header = request.headers.get("authorization") || "";
  return /^Bearer\s+(\S{1,500})$/i.exec(header)?.[1] || "";
}
