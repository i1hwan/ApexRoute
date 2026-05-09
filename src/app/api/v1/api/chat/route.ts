import { CORS_ORIGIN } from "@/shared/utils/cors";
import { handleChat } from "@/sse/handlers/chat";
import { transformToOllama } from "@omniroute/open-sse/utils/ollamaTransform.ts";

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

export async function POST(request) {
  const clonedReq = request.clone();
  let modelName = "llama3.2";
  try {
    const body = await clonedReq.json();
    modelName = body.model || "llama3.2";
  } catch {}

  const response = await handleChat(request);
  return transformToOllama(response, modelName);
}
