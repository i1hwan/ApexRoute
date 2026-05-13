const DEFAULT_CODEX_CLIENT_VERSION = "0.130.0";
const DEFAULT_CODEX_USER_AGENT_PLATFORM = "Windows 10.0.26200";
const DEFAULT_CODEX_USER_AGENT_ARCH = "x64";

const CODEX_VERSION_OVERRIDE_ENV = "CODEX_CLIENT_VERSION";
const LEGACY_CODEX_USER_AGENT_ENV = "CODEX_USER_AGENT";
const CODEX_USER_AGENT_OVERRIDE_ENV = "CODEX_USER_AGENT_OVERRIDE";

const SAFE_HEADER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SAFE_HEADER_VALUE_PATTERN = /^[\x20-\x7E]{1,200}$/;
const CODEX_CLI_USER_AGENT_PATTERN = /^codex-cli\/([A-Za-z0-9][A-Za-z0-9._-]{0,31})(\s+\([^)]+\))$/;

function getSafeEnvValue(name: string, pattern: RegExp): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;

  const normalized = raw.trim();
  if (!normalized || !pattern.test(normalized)) return null;

  return normalized;
}

export function getCodexClientVersion(): string {
  return (
    getSafeEnvValue(CODEX_VERSION_OVERRIDE_ENV, SAFE_HEADER_TOKEN_PATTERN) ||
    DEFAULT_CODEX_CLIENT_VERSION
  );
}

export function getCodexUserAgent(): string {
  const explicitOverride = getSafeEnvValue(
    CODEX_USER_AGENT_OVERRIDE_ENV,
    SAFE_HEADER_VALUE_PATTERN
  );
  if (explicitOverride) return explicitOverride;

  const version = getCodexClientVersion();
  const legacyUserAgent = getSafeEnvValue(LEGACY_CODEX_USER_AGENT_ENV, SAFE_HEADER_VALUE_PATTERN);
  const codexCliMatch = legacyUserAgent?.match(CODEX_CLI_USER_AGENT_PATTERN);
  if (codexCliMatch) {
    return `codex-cli/${version}${codexCliMatch[2]}`;
  }

  return `codex-cli/${version} (${DEFAULT_CODEX_USER_AGENT_PLATFORM}; ${DEFAULT_CODEX_USER_AGENT_ARCH})`;
}

export function getCodexDefaultHeaders(): Record<string, string> {
  return {
    Version: getCodexClientVersion(),
    "Openai-Beta": "responses=experimental",
    "X-Codex-Beta-Features": "responses_websockets",
    "User-Agent": getCodexUserAgent(),
  };
}
