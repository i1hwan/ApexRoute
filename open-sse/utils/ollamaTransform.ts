import { getCorsOrigin } from "./cors.ts";

type PendingToolCall = {
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
};

// Transform OpenAI SSE stream to Ollama JSON lines format
export function transformToOllama(response, model) {
  let buffer = "";
  let pendingToolCalls: Record<number, PendingToolCall> = {};
  const completedToolCalls: PendingToolCall[] = [];

  // Outer-scoped decoder with `stream: true` is required to stitch multi-byte
  // UTF-8 characters that the upstream HTTP body splits across chunks.
  // See responsesTransformer.ts for the same fix and combo.ts:607-708 for the
  // canonical comment explaining why per-chunk decoders corrupt non-ASCII text.
  const decoder = new TextDecoder();

  const transform = new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();

        if (data === "[DONE]") {
          const ollamaEnd =
            JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true }) +
            "\n";
          controller.enqueue(new TextEncoder().encode(ollamaEnd));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta || {};
          const content = delta.content || "";
          const toolCalls = delta.tool_calls;

          if (toolCalls) {
            for (const tc of toolCalls) {
              const idx = tc.index;

              // T37: Prevent merging tool_calls on same index if ID changes
              if (pendingToolCalls[idx] && tc.id && pendingToolCalls[idx].id !== tc.id) {
                completedToolCalls.push(pendingToolCalls[idx]);
                delete pendingToolCalls[idx];
              }

              if (!pendingToolCalls[idx]) {
                pendingToolCalls[idx] = { id: tc.id, function: { name: "", arguments: "" } };
              }
              if (tc.function?.name) pendingToolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments)
                pendingToolCalls[idx].function.arguments += tc.function.arguments;
            }
          }

          if (content) {
            const ollama =
              JSON.stringify({ model, message: { role: "assistant", content }, done: false }) +
              "\n";
            controller.enqueue(new TextEncoder().encode(ollama));
          }

          const finishReason = parsed.choices?.[0]?.finish_reason;
          if (finishReason === "tool_calls" || finishReason === "stop") {
            const toolCallsArr = [...completedToolCalls, ...Object.values(pendingToolCalls)];
            if (toolCallsArr.length > 0) {
              const formattedCalls = toolCallsArr.map((tc) => ({
                function: {
                  name: tc.function.name,
                  arguments: JSON.parse(tc.function.arguments || "{}"),
                },
              }));
              const ollama =
                JSON.stringify({
                  model,
                  message: { role: "assistant", content: "", tool_calls: formattedCalls },
                  done: true,
                }) + "\n";
              controller.enqueue(new TextEncoder().encode(ollama));
              pendingToolCalls = {};
            } else if (finishReason === "stop") {
              const ollamaEnd =
                JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true }) +
                "\n";
              controller.enqueue(new TextEncoder().encode(ollamaEnd));
            }
          }
        } catch (e) {
          // Silently ignore parse errors
        }
      }
    },
    flush(controller) {
      const tail = decoder.decode();
      if (tail) buffer += tail;

      const ollamaEnd =
        JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true }) + "\n";
      controller.enqueue(new TextEncoder().encode(ollamaEnd));
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Access-Control-Allow-Origin": getCorsOrigin(),
    },
  });
}
