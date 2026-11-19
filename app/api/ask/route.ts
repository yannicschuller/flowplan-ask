import { askRoute, optionsRoute, publicRoute } from "@/lib/routes";

// POST /api/ask (README "Public API").
export const dynamic = "force-dynamic";
export const POST = (request: Request) => publicRoute(request, () => askRoute(request));
export const OPTIONS = (request: Request) => optionsRoute(request, "POST");
