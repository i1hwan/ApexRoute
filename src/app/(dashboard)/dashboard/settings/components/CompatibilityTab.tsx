"use client";

import ToolArgumentModeSection from "./CompatibilityTab/ToolArgumentModeSection";
import LowQuotaBypassSection from "./CompatibilityTab/LowQuotaBypassSection";
import SSEDiagnosticsSection from "./CompatibilityTab/SSEDiagnosticsSection";
import TerminalRecoverySection from "./CompatibilityTab/TerminalRecoverySection";

export default function CompatibilityTab() {
  return (
    <div className="flex flex-col gap-6">
      <ToolArgumentModeSection />
      <LowQuotaBypassSection />
      <SSEDiagnosticsSection />
      <TerminalRecoverySection />
    </div>
  );
}
