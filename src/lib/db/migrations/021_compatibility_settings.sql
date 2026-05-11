INSERT OR IGNORE INTO key_value (namespace, key, value)
VALUES (
  'settings',
  'toolArgumentMode',
  '{"default":"stream-normalized","byProvider":{},"byLane":{}}'
);

INSERT OR IGNORE INTO key_value (namespace, key, value)
VALUES (
  'settings',
  'lowQuotaBypass',
  '{"default":false,"byProvider":{}}'
);

INSERT OR IGNORE INTO key_value (namespace, key, value)
VALUES (
  'settings',
  'sseDiagnostics',
  '{"captureProviderRawSSELines":false,"captureProviderParsedEvents":false,"captureTranslatedOpenAISSE":false,"keepLastNDebugRequests":20,"maxDebugBundleSizeMB":100,"maxActiveDebugBundles":5}'
);
