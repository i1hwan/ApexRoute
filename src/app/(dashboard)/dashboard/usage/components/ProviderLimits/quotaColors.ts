export const QUOTA_BAR_GREEN_THRESHOLD = 50;
export const QUOTA_BAR_YELLOW_THRESHOLD = 20;

export interface QuotaBarColors {
  bar: string;
  text: string;
  bg: string;
}

export function getBarColor(remainingPercentage: number): QuotaBarColors {
  if (remainingPercentage > QUOTA_BAR_GREEN_THRESHOLD) {
    return { bar: "#22c55e", text: "#22c55e", bg: "rgba(34,197,94,0.12)" };
  }
  if (remainingPercentage > QUOTA_BAR_YELLOW_THRESHOLD) {
    return { bar: "#eab308", text: "#eab308", bg: "rgba(234,179,8,0.12)" };
  }
  return { bar: "#ef4444", text: "#ef4444", bg: "rgba(239,68,68,0.12)" };
}
