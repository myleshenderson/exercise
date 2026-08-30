-- Server-side session store mapping an opaque MCP bearer token to the user's
-- Supabase refresh token. Read and written only by server-side code holding the
-- service-role key (the MCP route, the mcp-login page's server handler) — RLS is
-- enabled with no policies, so anon/authenticated clients get zero access even if
-- a future migration ever grants table privileges to those roles.
create table mcp_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  token text not null,
  refresh_token text not null,
  created_at timestamptz not null default now()
);

create unique index mcp_sessions_token_idx on mcp_sessions (token);

alter table mcp_sessions enable row level security;
