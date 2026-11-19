import { optionsRoute, publicRoute, statusRoute } from "@/lib/routes";

// GET /api/status: whether Flo answers on the docs and on Discord.
export const dynamic = "force-dynamic";
export const GET = (request: Request) => publicRoute(request, () => statusRoute());
export const OPTIONS = (request: Request) => optionsRoute(request, "GET");
