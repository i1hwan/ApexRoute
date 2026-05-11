import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  lowQuotaBypassSettingsSchema,
  LOW_QUOTA_BYPASS_DEFAULT,
  type LowQuotaBypassSettings,
} from "@/shared/validation/settingsSchemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export async function GET() {
  try {
    const settings = await getSettings();
    const stored = settings.lowQuotaBypass as LowQuotaBypassSettings | undefined;
    return NextResponse.json(stored ?? LOW_QUOTA_BYPASS_DEFAULT);
  } catch (error) {
    console.error("Error reading low-quota bypass settings:", error);
    return NextResponse.json(
      { error: "Failed to read low-quota bypass settings" },
      { status: 500 }
    );
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
    const validation = validateBody(lowQuotaBypassSettingsSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    await updateSettings({ lowQuotaBypass: validation.data });
    return NextResponse.json(validation.data);
  } catch (error) {
    console.error("Error updating low-quota bypass settings:", error);
    return NextResponse.json(
      { error: "Failed to update low-quota bypass settings" },
      { status: 500 }
    );
  }
}
