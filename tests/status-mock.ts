// A local stand-in for the status data of status.flowplan.org: summary.json
// (as the flowplan-status GitHub Action writes it) and services.json – never
// the network. `summary` / `services` can be replaced, `fail` makes both
// answer 500, `delayMs` holds the answer back; records the paths fetched.
import { createServer, type Server } from "node:http";

export const SERVICES = {
  groups: [
    {
      id: "cloud",
      name: { de: "Flowplan Cloud", en: "Flowplan Cloud" },
      services: [
        { id: "app", name: { de: "Web-App", en: "Web app" } },
        { id: "api", name: { de: "API und Synchronisierung", en: "API and sync" } },
      ],
    },
    {
      id: "public",
      name: { de: "Website und Hilfe", en: "Website and help" },
      services: [
        { id: "website", name: { de: "Website", en: "Website" } },
        { id: "docs", name: { de: "Dokumentation", en: "Documentation" } },
      ],
    },
  ],
};

export const allUp = (at = Date.now()) => ({
  status: "operational",
  updatedAt: new Date(at - 60_000).toISOString(),
  url: "https://status.flowplan.org",
  services: { app: "up", api: "up", website: "up", docs: "up" },
  incidents: [],
  maintenance: [],
});

export async function startStatusMock() {
  const paths: string[] = [];
  const state = { summary: allUp() as unknown, services: SERVICES as unknown, fail: false, delayMs: 0 };
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname;
    paths.push(path);
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const body = path === "/summary.json" ? state.summary : path === "/services.json" ? state.services : null;
    if (state.fail || body === null) {
      res.writeHead(state.fail ? 500 : 404, { "content-type": "text/plain" });
      return void res.end("no");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    paths,
    state,
    reset() {
      paths.length = 0;
      Object.assign(state, { summary: allUp(), services: SERVICES, fail: false, delayMs: 0 });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
