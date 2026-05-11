import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  sseDiagnosticsSettingsSchema,
  SSE_DIAGNOSTICS_DEFAULT,
  type SseDiagnosticsSettings,
} from "@/shared/validation/settingsSchemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export async function GET() {
  try {
    const settings = await getSettings();
    const stored = settings.sseDiagnostics as SseDiagnosticsSettings | undefined;
    return NextResponse.json(stored ?? SSE_DIAGNOSTICS_DEFAULT);
  } catch (error) {
    console.error("Error reading SSE diagnostics settings:", error);
    return NextResponse.json({ error: "Failed to read SSE diagnostics settings" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(sseDiagnosticsSettingsSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    await updateSettings({ sseDiagnostics: validation.data });
    return NextResponse.json(validation.data);
  } catch (error) {
    console.error("Error updating SSE diagnostics settings:", error);
    return NextResponse.json(
      { error: "Failed to update SSE diagnostics settings" },
      { status: 500 }
    );
  }
}
