-- Tracks when a session was last used to resolve a tool call (updated by
-- api/mcp-auth.ts's resolveIdentity alongside the refresh_token rotation),
-- so the /mcp-login session list can distinguish active sessions from stale
-- ones before a user revokes one.
alter table mcp_sessions add column last_used_at timestamptz not null default now();
