import { NextResponse } from "next/server";
import {
  getActiveSessions,
  getActiveSessionCount,
  getAllActiveSessionCountsByKey,
} from "@omniroute/open-sse/services/sessionManager.ts";
import {
  listProviderConnectionMetadata,
  type ProviderConnectionMetadata,
} from "@/lib/db/providers";
import { getAccountDisplayName } from "@/lib/display/names";

export async function GET() {
  try {
    const sessions = getActiveSessions();
    const count = getActiveSessionCount();
    const byApiKey = getAllActiveSessionCountsByKey();

    const sessionConnectionIds = Array.from(
      new Set(
        sessions
          .map((s) => s.connectionId)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      )
    );

    let connMap: Map<string, ProviderConnectionMetadata> = new Map();
    if (sessionConnectionIds.length > 0) {
      try {
        const connections = await listProviderConnectionMetadata(sessionConnectionIds);
        for (const c of connections) {
          if (c.id) connMap.set(c.id, c);
        }
      } catch (err) {
        connMap = new Map();
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[sessions] connection metadata lookup failed for ${sessionConnectionIds.length} ids: ${message}`
        );
      }
    }

    const enrichedSessions = sessions.map((s) => {
      const conn = s.connectionId ? connMap.get(s.connectionId) : null;
      return {
        ...s,
        accountName: conn
          ? getAccountDisplayName({
              id: conn.id,
              name: conn.name ?? undefined,
              displayName: conn.displayName ?? undefined,
              email: conn.email ?? undefined,
            })
          : null,
        provider: conn?.provider ?? null,
      };
    });

    return NextResponse.json({ count, sessions: enrichedSessions, byApiKey });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
