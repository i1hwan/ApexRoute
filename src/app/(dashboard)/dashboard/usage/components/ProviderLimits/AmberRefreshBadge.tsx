"use client";

import { useTranslations } from "next-intl";
import Badge from "@/shared/components/Badge";

export type RefreshTransientReason =
  | "rate_limited"
  | "upstream_5xx"
  | "timeout"
  | "network"
  | "unknown_transient";

interface Props {
  reason: RefreshTransientReason;
  since: string;
}

const REASON_LABEL_KEY: Record<RefreshTransientReason, string> = {
  rate_limited: "refreshTransientRateLimited",
  upstream_5xx: "refreshTransientUpstream5xx",
  timeout: "refreshTransientTimeout",
  network: "refreshTransientNetwork",
  unknown_transient: "refreshTransientUnknown",
};

export default function AmberRefreshBadge({ reason, since }: Props) {
  const t = useTranslations("usage");
  const reasonLabel = t(REASON_LABEL_KEY[reason] || "refreshTransientUnknown");
  const tooltip = t("refreshTransientTooltip", { reason: reasonLabel, since });
  return (
    <span title={tooltip} className="inline-flex items-center shrink-0" aria-label={tooltip}>
      <Badge variant="warning" size="sm" dot className="h-5 leading-none">
        {t("refreshTransientBadge")}
      </Badge>
    </span>
  );
}
