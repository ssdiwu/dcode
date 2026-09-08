/** Shared product setting contract; safe to consume from the renderer. */
export const MIN_MODEL_QUOTA_THRESHOLD_PERCENT = 1;
export const MAX_MODEL_QUOTA_THRESHOLD_PERCENT = 30;
export const DEFAULT_MODEL_QUOTA_THRESHOLD_PERCENT = 1;
export function isModelQuotaThresholdPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_MODEL_QUOTA_THRESHOLD_PERCENT && value <= MAX_MODEL_QUOTA_THRESHOLD_PERCENT;
}
