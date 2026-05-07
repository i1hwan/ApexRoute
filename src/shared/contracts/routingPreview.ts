export interface RoutingPreviewBreakdown {
  sessionPoints: number | null;
  weeklyPoints: number | null;
  sessionRemainingPct: number | null;
  weeklyRemainingPct: number | null;
  baseScore: number | null;
  penaltyError: number;
  penaltyBackoff: number;
  penaltyDegraded: number;
  finalScore: number | null;
}

export interface RoutingPreviewEntry {
  strategy: string;
  rank: number | null;
  isNext: boolean;
  excluded: boolean;
  excludedReason: string | null;
  score: number | null;
  breakdown: RoutingPreviewBreakdown | null;
}

export type RoutingPreviewMap = Record<string, RoutingPreviewEntry>;
