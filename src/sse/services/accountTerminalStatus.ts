// Canonical terminal-status helpers. Originally inlined in src/sse/services/auth.ts;
// extracted so other modules (e.g. earliestResetFirst.ts) reuse the same logic.

export interface TerminalStatusBearer {
  testStatus?: string | null;
}

export function normalizeStatus(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

export function isTerminalConnectionStatus(connection: TerminalStatusBearer): boolean {
  const status = normalizeStatus(connection.testStatus);
  return status === "credits_exhausted" || status === "banned" || status === "expired";
}
