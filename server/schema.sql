-- AuraDetector — reference database schema (PostgreSQL)
-- Store only what is necessary. NEVER store the original user photo in the
-- database; if you must persist an image temporarily, use private object
-- storage with short-lived signed URLs and auto-delete.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- users
create table users (
  id              uuid primary key default gen_random_uuid(),
  email           text unique,                       -- null for anonymous-first users
  password_hash   text,                              -- argon2/bcrypt only; null for OAuth-only
  provider        text,                              -- 'email' | 'google' | 'apple'
  provider_sub    text,                              -- OAuth subject id
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz,
  deleted_at      timestamptz                        -- GDPR soft-delete marker
);

-- -------------------------------------------------------- subscriptions
create table subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  provider              text not null,               -- 'stripe' | ...
  customer_id           text,
  subscription_id       text unique,
  plan                  text not null,               -- 'monthly' | 'yearly'
  status                text not null,               -- active | past_due | canceled | trialing
  current_period_end    timestamptz,
  cancel_at_period_end  boolean not null default false,
  updated_at            timestamptz not null default now()
);
create index on subscriptions (user_id);

-- ---------------------------------------------------------------- scans
-- One row per scan. Anonymous scans use an anon_id (no account required).
create table scans (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete set null,
  anon_id      text,                                 -- device-scoped anonymous id
  mode         text not null,                        -- 'image' | 'text'
  created_at   timestamptz not null default now()
);
create index on scans (user_id, created_at desc);
create index on scans (anon_id, created_at desc);

-- ---------------------------------------------------------- scan_results
-- Result data only. No original image, no raw personal content.
create table scan_results (
  scan_id       uuid primary key references scans(id) on delete cascade,
  score         int  not null check (score between 0 and 1000),
  tier          text not null,
  archetype     text not null,
  categories    jsonb not null,
  strengths     jsonb not null default '[]',
  improvements  jsonb not null default '[]',
  summary       text,
  engine        text,                                -- 'ai' | 'local'
  created_at    timestamptz not null default now()
);

-- ----------------------------------------------------------- usage_limits
create table usage_limits (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references users(id) on delete cascade,
  anon_id        text,
  day            date not null,
  scans_used     int  not null default 0,
  bonus_scans    int  not null default 0,
  ad_scans       int  not null default 0,
  unique (user_id, day),
  unique (anon_id, day)
);

-- -------------------------------------------------------------- referrals
create table referrals (
  id             uuid primary key default gen_random_uuid(),
  referrer_scan  uuid references scans(id) on delete set null,
  referred_user  uuid references users(id) on delete set null,
  code           text unique,
  created_at     timestamptz not null default now(),
  converted_at   timestamptz
);

-- ------------------------------------------------------- analytics_events
create table analytics_events (
  id           bigserial primary key,
  user_id      uuid references users(id) on delete set null,
  anon_id      text,
  event        text not null,                        -- scan_start | scan_result | paywall_view | pro_click | ...
  props        jsonb not null default '{}',          -- no PII
  created_at   timestamptz not null default now()
);
create index on analytics_events (event, created_at desc);

-- ------------------------------------------------------------------ notes
-- Enforce access with row-level security / server-side authorisation:
--   alter table scans enable row level security;
--   create policy scans_owner on scans using (user_id = current_setting('app.user_id')::uuid);
