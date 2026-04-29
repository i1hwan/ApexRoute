"use client";

import { useTranslations } from "next-intl";
import { pickMaskedDisplayValue } from "@/shared/utils/maskEmail";
import type { RoutingPreviewEntry } from "@/shared/contracts/routingPreview";

interface ConnectionLite {
  id: string;
  provider: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

interface ProviderConfigEntry {
  label: string;
}

interface RoutingTransparencyBannerProps {
  routing: Record<string, RoutingPreviewEntry>;
  configuredStrategy: string;
  connections: ConnectionLite[];
  providerConfig: Record<string, ProviderConfigEntry | undefined>;
}

const MAX_NAME_LEN = 16;

function truncate(value: string): string {
  if (!value || value.length <= MAX_NAME_LEN) return value || "";
  return value.slice(0, MAX_NAME_LEN - 1) + "…";
}

interface NextEntryByProvider {
  providerLabel: string;
  accountName: string | null;
  allExcluded: boolean;
  nextConnId: string | null;
}

function collectNextPerProvider(
  routing: Record<string, RoutingPreviewEntry>,
  connections: ConnectionLite[],
  providerConfig: Record<string, ProviderConfigEntry | undefined>
): NextEntryByProvider[] {
  const groups = new Map<string, ConnectionLite[]>();
  for (const conn of connections) {
    if (!groups.has(conn.provider)) groups.set(conn.provider, []);
    groups.get(conn.provider)!.push(conn);
  }

  const out: NextEntryByProvider[] = [];
  for (const [provider, group] of groups) {
    if (group.length === 0) continue;
    const providerLabel = providerConfig[provider]?.label ?? provider;
    let nextConn: ConnectionLite | null = null;
    let nonExcludedCount = 0;
    let excludedCount = 0;
    for (const conn of group) {
      const entry = routing[conn.id];
      if (!entry) continue;
      if (entry.excluded) excludedCount += 1;
      else nonExcludedCount += 1;
      if (entry.isNext) {
        nextConn = conn;
      }
    }
    const hasAnyEntry = nonExcludedCount + excludedCount > 0;
    out.push({
      providerLabel,
      accountName: nextConn
        ? truncate(
            pickMaskedDisplayValue(
              [nextConn.name, nextConn.displayName, nextConn.email],
              providerLabel
            )
          )
        : null,
      allExcluded: hasAnyEntry && nonExcludedCount === 0,
      nextConnId: nextConn?.id ?? null,
    });
  }
  return out;
}

function scrollToConnection(connectionId: string | null) {
  if (!connectionId || typeof document === "undefined") return;
  const el = document.querySelector(`[data-connection-id="${connectionId}"]`);
  if (el && "scrollIntoView" in el) {
    (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export default function RoutingTransparencyBanner({
  routing,
  configuredStrategy,
  connections,
  providerConfig,
}: RoutingTransparencyBannerProps) {
  const t = useTranslations("usage");
  const isERF = configuredStrategy === "earliest-reset-first";
  const nextEntries = isERF ? collectNextPerProvider(routing, connections, providerConfig) : [];

  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-border bg-bg-subtle text-[12px] text-text-muted">
      <span className="material-symbols-outlined text-[14px] mt-0.5 opacity-70">route</span>
      <div className="flex-1 min-w-0">
        <span className="font-medium text-text-main">
          {t("transparencyBannerStrategy", { strategy: configuredStrategy })}
        </span>
        {isERF && nextEntries.length > 0 && (
          <>
            <span className="mx-2 opacity-50">·</span>
            <span>{t("transparencyBannerNextLabel")}: </span>
            {nextEntries.map((e, i) => (
              <span key={`${e.providerLabel}-${i}`}>
                {i > 0 && <span className="opacity-50">, </span>}
                {e.allExcluded ? (
                  <span>
                    {e.providerLabel}{" "}
                    <span className="opacity-60">({t("transparencyBannerAllExcluded")})</span>
                  </span>
                ) : e.nextConnId ? (
                  <button
                    type="button"
                    onClick={() => scrollToConnection(e.nextConnId)}
                    className="underline decoration-dotted underline-offset-2 hover:text-text-main cursor-pointer bg-transparent border-0 p-0 m-0 text-inherit"
                  >
                    {e.providerLabel} <span className="opacity-70">({e.accountName ?? "—"})</span>
                  </button>
                ) : (
                  <span>
                    {e.providerLabel} <span className="opacity-70">({e.accountName ?? "—"})</span>
                  </span>
                )}
              </span>
            ))}
          </>
        )}
      </div>
      <span
        title={t("transparencyBannerDisclaimer")}
        className="material-symbols-outlined text-[14px] opacity-60 cursor-help shrink-0"
        aria-label={t("transparencyBannerDisclaimer")}
      >
        info
      </span>
    </div>
  );
}
