-- Full database schema. Run once on an empty Supabase project.
-- RLS is on with no policies on purpose: only the sms-ingest function
-- (service role) can read or write. Don't add public policies.

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  amount numeric,                                  -- always positive; kind gives the direction
  currency text default 'SAR',
  merchant text,                                   -- merchant or transfer counterparty
  raw_text text,                                   -- SMS text; null for statement rows
  created_at timestamptz not null default now(),   -- insert time
  type text,                                       -- pos | online | intl | transfer | bank | atm | other
  occurred_at timestamptz,                         -- payment time
  kind text not null default 'unknown',            -- purchase | refund | fee | income | cash_in | transfer_in | transfer_out | unknown
  category text not null default 'Uncategorized',  -- free text
  city text,                                       -- statement rows only
  mcc text,                                        -- merchant category code, statement rows only
  balance numeric,                                 -- balance after this row, statement rows only
  source text not null default 'sms',              -- sms | statement
  ref text,                                        -- statement dedupe key
  seq integer,                                     -- bank order across statements, keeps the balance line correct
  note text,
  excluded boolean not null default false,         -- true = left out of all totals
  sms_id text                                      -- id from sms.js, which queues SMS offline; a repeat is ignored
);
alter table public.payments enable row level security;

create unique index payments_ref_key on public.payments (ref) where ref is not null;
create unique index payments_sms_id_key on public.payments (sms_id) where sms_id is not null;
create index payments_occurred_at_idx on public.payments (occurred_at desc);

create table public.merchant_rules (
  merchant_key text primary key,                   -- lowercase, trimmed merchant name
  category text not null,
  updated_at timestamptz not null default now()
);
alter table public.merchant_rules enable row level security;

create table public.merchant_aliases (
  merchant_key text primary key,                   -- merchantKey() of the name as the bank writes it
  name text not null,                              -- the name to use instead (Rename in the app)
  updated_at timestamptz not null default now()
);
alter table public.merchant_aliases enable row level security;

create table public.category_limits (
  category text primary key,
  monthly numeric not null check (monthly > 0),    -- the most to spend in this category in a calendar month
  updated_at timestamptz not null default now()
);
alter table public.category_limits enable row level security;

-- ---------- Keys, push notifications, scheduled alerts, backups, bills and instalment plans ----------

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scope text not null check (scope in ('full', 'read', 'ingest', 'cron')), -- cron: ?action=tick only
  hash text not null unique,                       -- SHA-256 (hex) of the key; the key itself is never stored here
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,                          -- set to turn a key off
  expires_at timestamptz                           -- set for Face ID sessions (12 hours); device keys never expire
);
alter table public.api_keys enable row level security;

create table public.passkeys (
  id text primary key,                             -- the credential id, base64url
  public_key jsonb not null,                       -- its P-256 public key as a JWK
  sign_count bigint not null default 0,
  name text not null default 'iPhone',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.passkeys enable row level security;

create table public.auth_challenges (
  challenge text primary key,                      -- base64url, used once, valid for 5 minutes
  kind text not null check (kind in ('register', 'login')),
  ip text,
  created_at timestamptz not null default now()
);
alter table public.auth_challenges enable row level security;

create table public.auth_failures (
  ip text primary key,                             -- 10 wrong keys within 10 minutes lock the address for 15 minutes
  fails integer not null default 0,
  first_at timestamptz not null default now(),
  locked_until timestamptz
);
alter table public.auth_failures enable row level security;

create table public.push_subscriptions (
  endpoint text primary key,                       -- a push service URL (Apple, Google, Mozilla or Microsoft only)
  p256dh text not null,                            -- the device's public key, base64url
  auth text not null,                              -- the device's auth secret, base64url
  created_at timestamptz not null default now(),
  last_ok_at timestamptz                           -- last message the push service accepted
);
alter table public.push_subscriptions enable row level security;

create table public.app_settings (
  key text primary key,                            -- 'vapid' (the push key pair), 'last_backup', 'legacy_token' ({off, last_used}), 'webauthn_user'
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;

create table public.notify_log (
  key text primary key,                            -- one row per alert sent, e.g. 'weekly:2026-11-26', so each goes out once
  created_at timestamptz not null default now()
);
alter table public.notify_log enable row level security;

create table public.bills (
  key text primary key,                            -- the app's fixedKey(): lowercase merchant|amount with 2 decimals
  label text not null,                             -- what the reminder says: the merchant, or the category for a transfer (rent)
  amount numeric not null check (amount > 0),
  day integer not null check (day between 1 and 31), -- usual day of the month
  category text,
  updated_at timestamptz not null default now()
);
alter table public.bills enable row level security;

create table public.bnpl_plans (
  id uuid primary key default gen_random_uuid(),   -- made by the app, so a plan saved offline keeps its id
  provider text not null,                          -- matched against payment merchants: Tabby, Tamara, ...
  amount numeric not null check (amount > 0),      -- each instalment
  count integer not null check (count between 1 and 36),
  first date not null,                             -- the first instalment
  every text not null default 'month' check (every in ('month', '2weeks')),
  paid integer not null default 0,                 -- instalments marked as paid so far, for payments the app can't see
  note text,
  created_at timestamptz not null default now()
);
alter table public.bnpl_plans add constraint bnpl_plans_paid_range check (paid >= 0 and paid <= count);
alter table public.bnpl_plans enable row level security;

-- Weekly backups go here. Private: only the service role can read it.
insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict (id) do nothing;

-- The scheduler: pg_cron calls the function at 7 minutes past every hour with a key that can only run ?action=tick.
-- The key is made inside the database and kept in Vault, so it never appears in a file, a log or a chat.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$
declare k text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into public.api_keys (name, scope, hash) values ('Scheduler (pg_cron)', 'cron', encode(extensions.digest(k, 'sha256'), 'hex'));
  perform vault.create_secret(k, 'cron_key', 'The key pg_cron sends to sms-ingest ?action=tick. It can run the scheduled jobs and nothing else.');
end $$;
-- Replace <project-ref> with the project's ref (it's in the API constant in index.html)
select cron.schedule('spending-tick', '7 * * * *', $job$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/sms-ingest?action=tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-api-key', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);
