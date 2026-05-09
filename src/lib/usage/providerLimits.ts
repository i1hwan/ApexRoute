import {
  getAllProviderLimitsCache,
  getProviderConnectionById,
  getProviderConnections,
  getSettings,
  resolveProxyForConnection,
  setProviderLimitsCache,
  setProviderLimitsCacheBatch,
  updateProviderConnection,
  updateSettings,
  type ProviderLimitsCacheEntry,
} from "@/lib/localDb";
import { syncToCloud } from "@/lib/cloudSync";
import { setQuotaCache } from "@/domain/quotaCache";
import { getMachineId } from "@/shared/utils/machine";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { getExecutor } from "@omniroute/open-sse/executors/index.ts";
import { getUsageForProvider } from "@omniroute/open-sse/services/usage.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import {
  refreshClaudeOAuthTokenWithRetry,
  type ClaudeRefreshClassification,
  type ClaudeRefreshTransientReason,
} from "@omniroute/open-sse/services/tokenRefresh.ts";

type JsonRecord = Record<string, unknown>;

type SyncSource = "manual" | "scheduled";

interface ProviderConnectionLike {
  id: string;
  provider: string;
  authType?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  providerSpecificData?: JsonRecord;
  testStatus?: string;
  isActive?: boolean;
}

const PROVIDER_LIMITS_APIKEY_PROVIDERS = new Set(["glm"]);
const DEFAULT_PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES = 70;
const PROVIDER_LIMITS_AUTO_SYNC_SETTING_KEY = "provider_limits_auto_sync_last_run";

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toProviderLimitsCacheEntry(
  usage: JsonRecord,
  source: SyncSource,
  fetchedAt = new Date().toISOString()
): ProviderLimitsCacheEntry {
  return {
    quotas: isRecord(usage.quotas) ? usage.quotas : null,
    plan: usage.plan ?? null,
    message: typeof usage.message === "string" ? usage.message : null,
    fetchedAt,
    source,
  };
}

function isSupportedUsageConnection(connection: ProviderConnectionLike | null): boolean {
  if (
    !connection ||
    !connection.provider ||
    !USAGE_SUPPORTED_PROVIDERS.includes(connection.provider)
  ) {
    return false;
  }

  if (connection.authType === "oauth") return true;
  return (
    connection.authType === "apikey" && PROVIDER_LIMITS_APIKEY_PROVIDERS.has(connection.provider)
  );
}

function withStatus(error: Error, status: number): Error & { status: number } {
  return Object.assign(error, { status });
}

async function syncToCloudIfEnabled() {
  try {
    const machineId = await getMachineId();
    if (!machineId) return;
    await syncToCloud(machineId);
  } catch (error) {
    console.error("[ProviderLimits] Error syncing refreshed credentials to cloud:", error);
  }
}

export type RefreshWarning = {
  kind: "refresh_transient";
  reason: ClaudeRefreshTransientReason;
  cause?: string;
  since: string;
};

type RefreshOutcome = {
  connection: ProviderConnectionLike;
  refreshed: boolean;
  warning?: RefreshWarning;
};

async function refreshAndUpdateCredentials(
  connection: ProviderConnectionLike
): Promise<RefreshOutcome> {
  const executor = getExecutor(connection.provider);
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.tokenExpiresAt,
    providerSpecificData: connection.providerSpecificData,
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  if (!executor.needsRefresh(credentials)) {
    return { connection, refreshed: false };
  }

  if (connection.provider === "claude" && connection.refreshToken) {
    const classified: ClaudeRefreshClassification = await refreshClaudeOAuthTokenWithRetry(
      connection.refreshToken,
      console
    );
    if (classified.status === "transient") {
      return {
        connection,
        refreshed: false,
        warning: {
          kind: "refresh_transient",
          reason: classified.reason,
          cause: classified.cause,
          since: new Date().toISOString(),
        },
      };
    }
    if (classified.status === "permanent") {
      throw withStatus(
        new Error(
          `Failed to refresh credentials (${classified.reason}). Please re-authorize the connection.`
        ),
        401
      );
    }
    const updateData: JsonRecord = {
      updatedAt: new Date().toISOString(),
      accessToken: classified.accessToken,
    };
    if (classified.refreshToken) {
      updateData.refreshToken = classified.refreshToken;
    }
    if (classified.expiresIn) {
      updateData.tokenExpiresAt = new Date(Date.now() + classified.expiresIn * 1000).toISOString();
    }
    await updateProviderConnection(connection.id, updateData);
    return {
      connection: {
        ...connection,
        ...updateData,
      },
      refreshed: true,
    };
  }

  const refreshResult = await executor.refreshCredentials(credentials, console);

  if (!refreshResult) {
    if (connection.provider === "github" && connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw withStatus(
      new Error("Failed to refresh credentials. Please re-authorize the connection."),
      401
    );
  }

  const updateData: JsonRecord = {
    updatedAt: new Date().toISOString(),
  };

  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }
  if (refreshResult.expiresIn) {
    updateData.tokenExpiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
  } else if (refreshResult.expiresAt) {
    updateData.tokenExpiresAt = refreshResult.expiresAt;
  }
  if (refreshResult.copilotToken || refreshResult.copilotTokenExpiresAt) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      copilotToken: refreshResult.copilotToken,
      copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt,
    };
  }

  await updateProviderConnection(connection.id, updateData);

  return {
    connection: {
      ...connection,
      ...updateData,
      providerSpecificData:
        (updateData.providerSpecificData as JsonRecord | undefined) ||
        connection.providerSpecificData,
    },
    refreshed: true,
  };
}

function isNetworkFailureMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("Proxy unreachable") ||
    message.includes("UND_ERR_CONNECT_TIMEOUT")
  );
}

async function syncExpiredStatusIfNeeded(connection: ProviderConnectionLike, usage: JsonRecord) {
  const errorMessage = typeof usage.message === "string" ? usage.message.toLowerCase() : "";
  const isAuthError =
    errorMessage.includes("token expired") ||
    errorMessage.includes("access denied") ||
    errorMessage.includes("re-authenticate") ||
    errorMessage.includes("unauthorized");

  if (!isAuthError || connection.testStatus === "expired") {
    return;
  }

  try {
    await updateProviderConnection(connection.id, {
      testStatus: "expired",
      lastErrorType: "token_expired",
      lastErrorAt: new Date().toISOString(),
    });
  } catch (dbError) {
    console.error("[ProviderLimits] Failed to sync expired status to DB:", dbError);
  }
}

export function getProviderLimitsSyncIntervalMinutes(): number {
  const raw = Number.parseInt(process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES;
}

export function getProviderLimitsSyncIntervalMs(): number {
  return getProviderLimitsSyncIntervalMinutes() * 60 * 1000;
}

export async function getLastProviderLimitsAutoSyncTime(): Promise<string | null> {
  try {
    const settings = await getSettings();
    const value = settings[PROVIDER_LIMITS_AUTO_SYNC_SETTING_KEY];
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

async function setLastProviderLimitsAutoSyncTime(timestamp: string): Promise<void> {
  await updateSettings({ [PROVIDER_LIMITS_AUTO_SYNC_SETTING_KEY]: timestamp });
}

export function getCachedProviderLimitsMap(): Record<string, ProviderLimitsCacheEntry> {
  return getAllProviderLimitsCache();
}

export type FetchLiveResult = {
  connection: ProviderConnectionLike;
  usage: JsonRecord;
  warning?: RefreshWarning;
  /**
   * False when the result is a synthetic transient response built from
   * cached snapshot or no-cache placeholder. Callers MUST NOT persist
   * such results — doing so would clobber the real cache or rewrite
   * stale `fetchedAt` timestamps.
   */
  persist: boolean;
};

function buildTransientFromCache(
  connection: ProviderConnectionLike,
  warning: RefreshWarning
): FetchLiveResult {
  const cached = getAllProviderLimitsCache()[connection.id];
  if (cached) {
    return {
      connection,
      usage: {
        quotas: cached.quotas,
        plan: cached.plan,
        message: cached.message,
        fetchedAt: cached.fetchedAt,
        source: "cache_stale_pending_refresh",
      },
      warning,
      persist: false,
    };
  }
  return {
    connection,
    usage: {
      quotas: null,
      plan: null,
      message: "Temporarily unavailable; no cached limits yet",
      fetchedAt: null,
      source: "no_cache_pending_refresh",
    },
    warning,
    persist: false,
  };
}

export async function fetchLiveProviderLimits(connectionId: string): Promise<FetchLiveResult> {
  let connection = (await getProviderConnectionById(connectionId)) as ProviderConnectionLike | null;
  if (!connection) {
    throw withStatus(new Error("Connection not found"), 404);
  }

  if (!isSupportedUsageConnection(connection)) {
    throw withStatus(new Error("Usage not available for this connection"), 400);
  }

  if (connection.authType !== "oauth") {
    const usage = (await getUsageForProvider(connection)) as JsonRecord;
    if (isRecord(usage.quotas)) {
      setQuotaCache(connectionId, connection.provider, usage.quotas);
    }
    await syncExpiredStatusIfNeeded(connection, usage);
    return { connection, usage, persist: true };
  }

  const proxyInfo = await resolveProxyForConnection(connectionId);

  const fetchUsageWithContext = async (
    proxyConfig: unknown
  ): Promise<{ usage: JsonRecord; warning?: RefreshWarning; persist: boolean }> =>
    runWithProxyContext(proxyConfig, async () => {
      let conn = connection as ProviderConnectionLike;
      let wasRefreshed = false;

      const result = await refreshAndUpdateCredentials(conn);
      conn = result.connection;
      wasRefreshed = result.refreshed;

      if (result.warning) {
        connection = conn;
        const synthetic = buildTransientFromCache(conn, result.warning);
        return { usage: synthetic.usage, warning: result.warning, persist: false };
      }

      if (wasRefreshed) {
        await syncToCloudIfEnabled();
      }

      const usageData = (await getUsageForProvider(conn)) as JsonRecord;
      connection = conn;
      return { usage: usageData, persist: true };
    });

  let result: { usage: JsonRecord; warning?: RefreshWarning; persist: boolean };
  const proxyConfig = proxyInfo?.proxy || null;

  try {
    result = await fetchUsageWithContext(proxyConfig);
  } catch (error: any) {
    const isThrownNetworkError =
      error?.message === "fetch failed" ||
      error?.code === "PROXY_UNREACHABLE" ||
      error?.code === "UND_ERR_CONNECT_TIMEOUT" ||
      error?.cause?.code === "ECONNREFUSED";

    if (proxyConfig && isThrownNetworkError) {
      console.warn(
        `[ProviderLimits] Proxy fetch threw for ${connectionId}, retrying without proxy:`,
        error?.message
      );
      result = await fetchUsageWithContext(null);
    } else {
      throw error;
    }
  }

  if (proxyConfig && !result.warning && isNetworkFailureMessage(result.usage?.message)) {
    console.warn(
      `[ProviderLimits] Proxy usage returned network error for ${connectionId}, retrying without proxy:`,
      result.usage.message
    );
    result = await fetchUsageWithContext(null);
  }

  if (!result.warning && isRecord(result.usage.quotas)) {
    setQuotaCache(connectionId, connection.provider, result.usage.quotas);
  }
  if (!result.warning) {
    await syncExpiredStatusIfNeeded(connection, result.usage);
  }

  return {
    connection,
    usage: result.usage,
    warning: result.warning,
    persist: result.persist,
  };
}

export async function fetchAndPersistProviderLimits(
  connectionId: string,
  source: SyncSource = "manual"
): Promise<{
  connection: ProviderConnectionLike;
  usage: JsonRecord;
  cache: ProviderLimitsCacheEntry | null;
  warning?: RefreshWarning;
}> {
  const result = await fetchLiveProviderLimits(connectionId);
  if (!result.persist) {
    return {
      connection: result.connection,
      usage: result.usage,
      cache: null,
      warning: result.warning,
    };
  }
  const cache = toProviderLimitsCacheEntry(result.usage, source);
  setProviderLimitsCache(connectionId, cache);
  return { connection: result.connection, usage: result.usage, cache, warning: result.warning };
}

export async function syncAllProviderLimits(
  options: {
    source?: SyncSource;
    concurrency?: number;
  } = {}
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  caches: Record<string, ProviderLimitsCacheEntry>;
  errors: Record<string, string>;
  warnings: Record<string, RefreshWarning>;
}> {
  const { source = "manual", concurrency = 5 } = options;
  const connections = (
    (await getProviderConnections({ isActive: true })) as ProviderConnectionLike[]
  ).filter(isSupportedUsageConnection);
  const cacheEntries: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }> = [];
  const caches: Record<string, ProviderLimitsCacheEntry> = {};
  const errors: Record<string, string> = {};
  const warnings: Record<string, RefreshWarning> = {};

  for (let i = 0; i < connections.length; i += concurrency) {
    const chunk = connections.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (connection) => {
        const live = await fetchLiveProviderLimits(connection.id);
        const cache = toProviderLimitsCacheEntry(live.usage, source);
        return {
          connectionId: connection.id,
          cache,
          warning: live.warning,
          persist: live.persist,
        };
      })
    );

    results.forEach((result, index) => {
      const connectionId = chunk[index]?.id;
      if (!connectionId) return;

      if (result.status === "fulfilled") {
        const { cache, warning, persist } = result.value;
        if (persist) {
          cacheEntries.push({
            connectionId: result.value.connectionId,
            entry: cache,
          });
        }
        caches[result.value.connectionId] = cache;
        if (warning) {
          warnings[result.value.connectionId] = warning;
        }
        return;
      }

      const reason = result.reason as { message?: string } | undefined;
      errors[connectionId] = reason?.message || "Failed to refresh provider limits";
    });
  }

  if (cacheEntries.length > 0) {
    setProviderLimitsCacheBatch(cacheEntries);
  }

  if (source === "scheduled") {
    await setLastProviderLimitsAutoSyncTime(new Date().toISOString());
  }

  return {
    total: connections.length,
    succeeded: connections.length - Object.keys(errors).length,
    failed: Object.keys(errors).length,
    caches,
    errors,
    warnings,
  };
}
