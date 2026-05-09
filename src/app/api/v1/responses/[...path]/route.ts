import { CORS_ORIGIN } from "@/shared/utils/cors";
import { handleChat } from "@/sse/handlers/chat";

// initTranslators() removed — see /v1/responses/route.ts (#450, PR #29).

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/responses/:path* - OpenAI Responses subpaths
 * Reuses the shared chat handler so native Codex passthrough can keep
 * arbitrary Responses suffixes all the way to the upstream provider.
 */
export async function POST(request) {
  return await handleChat(request);
}
