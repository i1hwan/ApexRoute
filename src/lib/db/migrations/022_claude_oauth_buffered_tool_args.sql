INSERT OR IGNORE INTO key_value (namespace, key, value)
VALUES (
  'settings',
  'toolArgumentMode',
  '{"default":"stream-normalized","byProvider":{},"byLane":{"claude-oauth-prefixed":"buffered-final"}}'
);

UPDATE key_value
SET value = '{"default":"stream-normalized","byProvider":{},"byLane":{"claude-oauth-prefixed":"buffered-final"}}'
WHERE namespace = 'settings'
  AND key = 'toolArgumentMode'
  AND value = '{"default":"stream-normalized","byProvider":{},"byLane":{}}';
