import { handle } from "@/lib/http";
import { adminRoute } from "@/lib/routes";

// /api/admin/settings | summary | usage | topics | blocklist | log | insights | export (README "Admin API").
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ name: string }> };
const route = async (request: Request, ctx: Ctx) => {
  const { name } = await ctx.params;
  return handle(() => adminRoute(request, name));
};
export const GET = route;
export const PUT = route;
export const POST = route;
export const DELETE = route;
