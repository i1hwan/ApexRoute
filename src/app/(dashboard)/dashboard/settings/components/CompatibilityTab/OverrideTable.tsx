"use client";

import { useMemo, useState } from "react";
import { Button } from "@/shared/components";
import { useTranslations } from "next-intl";

interface OverrideOption<V extends string | boolean> {
  value: V;
  label: string;
}

interface OverrideTableProps<V extends string | boolean> {
  overrides: Record<string, V>;
  availableKeys: readonly string[];
  valueOptions: OverrideOption<V>[];
  defaultNewValue: V;
  keyColumnLabel: string;
  valueColumnLabel: string;
  addButtonLabel: string;
  selectKeyPlaceholder: string;
  emptyStateLabel: string;
  formatKey?: (k: string) => string;
  onChange: (next: Record<string, V>) => void;
  disabled?: boolean;
}

export default function OverrideTable<V extends string | boolean>({
  overrides,
  availableKeys,
  valueOptions,
  defaultNewValue,
  keyColumnLabel,
  valueColumnLabel,
  addButtonLabel,
  selectKeyPlaceholder,
  emptyStateLabel,
  formatKey,
  onChange,
  disabled = false,
}: OverrideTableProps<V>) {
  const t = useTranslations("settings");
  const [pendingNewKey, setPendingNewKey] = useState<string>("");

  const remainingKeys = useMemo(
    () => availableKeys.filter((k) => !(k in overrides)),
    [availableKeys, overrides]
  );

  const entries = useMemo(() => Object.entries(overrides), [overrides]);

  const handleAddRow = () => {
    if (!pendingNewKey || pendingNewKey in overrides) return;
    onChange({ ...overrides, [pendingNewKey]: defaultNewValue });
    setPendingNewKey("");
  };

  const handleChangeValue = (key: string, nextValue: V) => {
    onChange({ ...overrides, [key]: nextValue });
  };

  const handleRemove = (key: string) => {
    const { [key]: _removed, ...rest } = overrides;
    onChange(rest as Record<string, V>);
  };

  const renderKey = formatKey ?? ((k: string) => k);

  return (
    <div className="flex flex-col gap-3">
      {entries.length === 0 ? (
        <div className="text-xs text-text-muted italic py-2">{emptyStateLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-text-muted border-b border-border/40">
                <th className="py-2 pr-4 font-medium">{keyColumnLabel}</th>
                <th className="py-2 pr-4 font-medium">{valueColumnLabel}</th>
                <th className="py-2 pr-2 font-medium w-20"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key} className="border-b border-border/20 last:border-b-0">
                  <td className="py-2 pr-4 font-mono text-xs">{renderKey(key)}</td>
                  <td className="py-2 pr-4">
                    <select
                      disabled={disabled}
                      value={String(value)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const matched = valueOptions.find((opt) => String(opt.value) === raw);
                        if (matched) handleChangeValue(key, matched.value);
                      }}
                      className="bg-surface/60 border border-border/50 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/40"
                    >
                      {valueOptions.map((opt) => (
                        <option key={String(opt.value)} value={String(opt.value)}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => handleRemove(key)}
                      aria-label={t("compatibilityRemoveAction")}
                    >
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          disabled={disabled || remainingKeys.length === 0}
          value={pendingNewKey}
          onChange={(e) => setPendingNewKey(e.target.value)}
          className="bg-surface/60 border border-border/50 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/40 flex-1"
        >
          <option value="">{selectKeyPlaceholder}</option>
          {remainingKeys.map((k) => (
            <option key={k} value={k}>
              {renderKey(k)}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || !pendingNewKey}
          onClick={handleAddRow}
        >
          <span className="material-symbols-outlined text-[16px] mr-1">add</span>
          {addButtonLabel}
        </Button>
      </div>
    </div>
  );
}
