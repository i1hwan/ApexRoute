import { NextResponse } from "next/server";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getSseDiagnosticsDir } from "@/lib/logEnv";

export async function POST() {
  const dir = getSseDiagnosticsDir();
  let deletedCount = 0;
  try {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "ENOENT"
      ) {
        return NextResponse.json({ deletedCount: 0, dir });
      }
      throw err;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const info = await stat(fullPath);
        if (!info.isFile()) continue;
        await rm(fullPath);
        deletedCount += 1;
      } catch (err) {
        console.warn(`[sse-diagnostics/clear] failed to remove ${fullPath}:`, err);
      }
    }
    return NextResponse.json({ deletedCount, dir });
  } catch (error) {
    console.error("Error clearing SSE diagnostics bundles:", error);
    return NextResponse.json({ error: "Failed to clear SSE diagnostics" }, { status: 500 });
  }
}
