import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  toolArgumentModeSettingsSchema,
  TOOL_ARGUMENT_MODE_DEFAULT,
  type ToolArgumentModeSettings,
} from "@/shared/validation/settingsSchemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export async function GET() {
  try {
    const settings = await getSettings();
    const stored = settings.toolArgumentMode as ToolArgumentModeSettings | undefined;
    return NextResponse.json(stored ?? TOOL_ARGUMENT_MODE_DEFAULT);
  } catch (error) {
    console.error("Error reading tool argument mode settings:", error);
    return NextResponse.json(
      { error: "Failed to read tool argument mode settings" },
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
    const validation = validateBody(toolArgumentModeSettingsSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    await updateSettings({ toolArgumentMode: validation.data });
    return NextResponse.json(validation.data);
  } catch (error) {
    console.error("Error updating tool argument mode settings:", error);
    return NextResponse.json(
      { error: "Failed to update tool argument mode settings" },
      { status: 500 }
    );
  }
}
