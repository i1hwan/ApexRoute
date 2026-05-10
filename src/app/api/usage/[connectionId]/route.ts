import { fetchAndPersistProviderLimits } from "@/lib/usage/providerLimits";

/**
 * GET /api/usage/[connectionId] - Get live usage data for a specific connection
 * and persist the refreshed Provider Limits cache.
 *
 * Transient OAuth refresh failures (Anthropic 429 / 5xx / network) return
 * 200 with `usage.warning` populated and the cached snapshot (or a no-cache
 * placeholder) as the body. The dashboard keeps gauges visible and renders
 * an amber refresh badge instead of replacing the row with red Error 0%.
 * Permanent failures still surface as 401 (re-auth required).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const { connectionId } = await params;
    const { usage, warning } = await fetchAndPersistProviderLimits(connectionId, "manual");
    if (warning) {
      return Response.json({ ...usage, warning });
    }
    return Response.json(usage);
  } catch (error) {
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    const message = (error as Error)?.message || "Failed to fetch usage";
    console.error("[Usage API] Error fetching usage:", error);
    return Response.json({ error: message }, { status });
  }
}
