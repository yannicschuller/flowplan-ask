import { handle } from "@/lib/http";
import { botRoute } from "@/lib/routes";

// POST /api/bot/block | unblock | report-draft (README "Bot API").
export const dynamic = "force-dynamic";
export const POST = async (request: Request, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  return handle(() => botRoute(request, name));
};
