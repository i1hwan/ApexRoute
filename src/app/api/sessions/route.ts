import { NextResponse } from "next/server";
import {
  getActiveSessions,
  getActiveSessionCount,
  getAllActiveSessionCountsByKey,
} from "@omniroute/open-sse/services/sessionManager.ts";
import { getProviderConnections } from "@/lib/db/providers";
import { getAccountDisplayName } from "@/lib/display/names";

export async function GET() {
  try {
    const sessions = getActiveSessions();
    const count = getActiveSessionCount();
    const byApiKey = getAllActiveSessionCountsByKey();

    let connMap: Map<string, Record<string, unknown>> = new Map();
    try {
      const connections = await getProviderConnections();
      for (const c of connections) {
        const id = (c as Record<string, unknown>).id;
        if (typeof id === "string") connMap.set(id, c as Record<string, unknown>);
      }
    } catch {
      connMap = new Map();
    }

    const enrichedSessions = sessions.map((s) => {
      const conn = s.connectionId ? connMap.get(s.connectionId) : null;
      return {
        ...s,
        accountName: conn
          ? getAccountDisplayName({
              id: conn.id as string | undefined,
              name: conn.name as string | undefined,
              displayName: conn.displayName as string | undefined,
              email: conn.email as string | undefined,
            })
          : null,
        provider: conn ? ((conn.provider as string | undefined) ?? null) : null,
      };
    });

    return NextResponse.json({ count, sessions: enrichedSessions, byApiKey });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
