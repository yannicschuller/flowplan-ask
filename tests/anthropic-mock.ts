// A local stand-in for the Claude Messages API (POST /v1/messages), reached
// through the SDK's baseURL – never the network. It records every request
// (headers and body) and answers with `reply(body)`: by default an answer
// that names the first docs excerpt it was given in its sources line.
import { createServer, type IncomingMessage, type Server } from "node:http";

export type MockRequest = { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: any };
export type MockReply = {
  status?: number;
  text?: string;
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  error?: { type: string; message: string };
  delayMs?: number;
  // Drop the connection without an answer (a timeout or a network error).
  drop?: boolean;
};

// The user turn the service sent (one text block).
export const userText = (body: any): string => body?.messages?.[0]?.content?.[0]?.text ?? "";
export const questionOf = (body: any) => /<question>\n([\s\S]*?)\n<\/question>/.exec(userText(body))?.[1] ?? "";
export const excerptsOf = (body: any) => [...userText(body).matchAll(/<excerpt index="\d+" title="([^"]*)" url="([^"]*)">/g)].map((m) => ({ title: m[1], url: m[2] }));

export function defaultReply(body: any): MockReply {
  const first = excerptsOf(body)[0];
  const text = first
    ? "Here is how it works: see the docs.\n\n[sources: 1]\n[report: none]"
    : "I couldn't find that in the docs.";
  return { text };
}

export async function startAnthropicMock() {
  const requests: MockRequest[] = [];
  const state = { reply: defaultReply as (body: any) => MockReply };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  const server: Server = createServer(async (req, res) => {
    const raw = await read(req);
    const body = raw ? JSON.parse(raw) : undefined;
    const path = new URL(req.url || "/", "http://x").pathname;
    requests.push({ method: req.method || "GET", path, headers: req.headers, body });
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "request-id": "req_mock_1", ...headers });
      res.end(JSON.stringify(data));
    };
    if (path !== "/v1/messages" || req.method !== "POST") return send(404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
    const r = state.reply(body);
    if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
    if (r.drop) return void req.socket.destroy();
    if (r.error) return send(r.status ?? 500, { type: "error", error: r.error }, { "retry-after-ms": "1" });
    send(200, {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: r.text ?? "" }],
      stop_reason: r.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: r.usage ?? { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    requests,
    set reply(fn: (body: any) => MockReply) {
      state.reply = fn;
    },
    reset() {
      requests.length = 0;
      state.reply = defaultReply;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
