import { optionsRoute, publicRoute, sessionRoute } from "@/lib/routes";

// POST /api/session: proof-of-work challenge, then a session token.
export const dynamic = "force-dynamic";
export const POST = (request: Request) => publicRoute(request, () => sessionRoute(request));
export const OPTIONS = (request: Request) => optionsRoute(request, "POST");
