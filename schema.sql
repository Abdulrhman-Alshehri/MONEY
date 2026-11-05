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
  excluded boolean not null default false          -- true = left out of all totals
);
alter table public.payments enable row level security;

create unique index payments_ref_key on public.payments (ref) where ref is not null;
create index payments_occurred_at_idx on public.payments (occurred_at desc);

create table public.merchant_rules (
  merchant_key text primary key,                   -- lowercase, trimmed merchant name
  category text not null,
  updated_at timestamptz not null default now()
);
alter table public.merchant_rules enable row level security;
