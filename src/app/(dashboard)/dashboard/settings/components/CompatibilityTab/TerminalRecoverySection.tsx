"use client";

import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";

export default function TerminalRecoverySection() {
  const t = useTranslations("settings");

  return (
    <Card className="opacity-70">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 rounded-lg bg-gray-500/10 text-gray-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            healing
          </span>
        </div>
        <h3 className="text-lg font-semibold">{t("compatibilityTerminalRecoveryTitle")}</h3>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-500">
          {t("compatibilityTerminalRecoveryDisabled")}
        </span>
      </div>
      <p className="text-sm text-text-muted">{t("compatibilityTerminalRecoveryDescription")}</p>
    </Card>
  );
}
