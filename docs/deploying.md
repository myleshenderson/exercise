# Deploying on Vercel + Supabase

This is the deployment the owner runs: the SPA and the MCP server on Vercel,
data and sign-in on Supabase. For what the app is, see the
[root README](../README.md). For the two Starkeep deployments, see
[starkeep/README.md](../starkeep/README.md).

The steps below start from nothing. You need a Supabase account, a Vercel
account, a GitHub fork or copy of this repo, and the
[Supabase CLI](https://supabase.com/docs/guides/cli).

## 1. Create the Supabase project

1. In the Supabase dashboard, create a new project. Note its **project ref**
   (the `<ref>` in `https://<ref>.supabase.co`).
2. From the project's API settings, note the project URL, the publishable
   (anon) key and the service role key. The service role key is a secret: it
   goes only into Vercel's server-side variables below, never into a `VITE_`
   variable.
3. Under **Authentication → URL Configuration**, set **Site URL** to the
   address the app will have on Vercel (you can come back to this after step
   4). The sign-in screen sends a magic link by email, and the link returns
   to the Site URL.

The email provider is on by default, which is all sign-in needs.

## 2. Apply the migrations

From the repo root:

```bash
supabase login
supabase link --project-ref <ref>
supabase db push --remote
```

`supabase db push --remote` applies every file in `supabase/migrations/` that
the project has not recorded yet. The flag is for CLI 3.x, where `db push`
targets a local stack by default (CLI 2.x spelled it `--linked`). After the first deploy, CI does this for you on
every merge to `main`; see [How migrations reach production](#how-migrations-reach-production).

## 3. Create the Vercel project

Import the repository in Vercel. `vercel.json` sets the framework to Vite,
the build command to `npm run build`, the output directory to `dist`, and a
rewrite that sends every other path to `index.html` so client routes work.
Vercel deploys the files in `api/` as serverless functions.

Set these environment variables (Project Settings → Environment Variables):

| Variable | Read by | Value |
| --- | --- | --- |
| `VITE_DATA_BACKEND` | the SPA, at build time | `supabase` |
| `VITE_SUPABASE_URL` | the SPA, at build time | the project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the SPA, at build time | the publishable (anon) key |
| `SUPABASE_URL` | `api/` functions, at run time | the project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `api/` functions, at run time | the service role key |

Vite bakes the `VITE_` values into the build, so change them and then
redeploy. Without `VITE_DATA_BACKEND=supabase` the build uses the mock
backend and nobody signs in.

## 4. Deploy

Deploy from the Vercel dashboard (or push to the branch Vercel watches).
Open the deployed URL, enter your email, and follow the magic link. On the
first sign-in the app seeds your account with starter exercises and day
templates.

If you skipped the Site URL in step 1, set it now to the Vercel URL.

## 5. Create the first MCP token

Open the **MCP** screen (`/mcp-login`) and create a token. The root README's
[Talk to it from Claude](../README.md#talk-to-it-from-claude) section covers
connecting a client.

## How migrations reach production

**Policy: migrations auto-apply to production from `main`.** A file merged
into `supabase/migrations/` on `main` is applied by the `migrate` job in
`.github/workflows/ci.yml` on the CI run for that push.

The `migrate` job:

- needs the `test` job to pass, and runs only on push to `main`;
- fails before anything else runs if the `SUPABASE_PROJECT_REF` repository
  secret is unset;
- runs `node scripts/check-migration-versions.mjs supabase/migrations`, which
  fails if two migration files share a version prefix;
- then runs `supabase link --project-ref "$SUPABASE_PROJECT_REF"` and
  `supabase db push --remote` with a pinned CLI version, authenticated with
  the `SUPABASE_ACCESS_TOKEN` repository secret;
- logs a `::warning::` and exits 0 without applying anything if
  `SUPABASE_ACCESS_TOKEN` is unset, rather than failing `main`.

To turn it on for your copy, add two repository secrets (**Settings → Secrets
and variables → Actions**):

| Secret | Value |
| --- | --- |
| `SUPABASE_PROJECT_REF` | the project ref from step 1 |
| `SUPABASE_ACCESS_TOKEN` | a Supabase personal access token (Account → Access Tokens) |

No `SUPABASE_DB_PASSWORD` is needed: Supabase CLI 2.x provisions a temporary
login role from the access token. The project ref lives in a secret, not in
a tracked file, so the public tree does not name the production project.

Create every new migration with `supabase migration new <name>`, so its
filename starts with a unique timestamp. `supabase db push` records one
applied migration per version; two files with the same prefix means one is
silently skipped, which is why the version check runs first.

### History

Supabase's dashboard GitHub-branch integration was set up when the project
was created and entered `MIGRATIONS_FAILED` the next day (2026-06-23). The
Management API gives no detail on a failed branch migration, so it was
decommissioned (exercise-4ly) in favour of the CI job above, the setup the
owner's `dice-engine` project already used. Every migration before that fix
reached production by a manual `supabase db push` or manual application.

Two migrations, `20260906151951_scheme_history.sql` and
`20260906152003_adherence_for_day_rpc.sql`, were once named `0012_…` and
`0013_…`. The `0012` prefix collided with `0012_mcp_sessions_last_used_at.sql`
and blocked `supabase db push`, so they were applied through the Management
API, which recorded timestamp versions. The files were renamed to match
those recorded versions; any other name would leave `supabase db push`
unable to reconcile the files with the remote ledger.

`20260906180000_day_sequencing.sql` and
`20260906180000_exercises_soft_delete.sql` were merged with the same
version, and only the second was applied, although `supabase db push`
reported success (exercise-8qg). `day_sequencing` was renamed to
`20260906180100_day_sequencing.sql` so the next push applied it, and the
version check above was added (exercise-kch).
