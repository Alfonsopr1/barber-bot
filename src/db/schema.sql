-- Phase 0 schema: all tenant tables, RLS enabled, anti double-booking constraint.
-- Run this against the Supabase project's Postgres database (SQL editor or migration tool).

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- One row per tenant business (shop). Identified by Meta's phone_number_id,
-- never by the human-readable display number.
create table shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business_type text not null default 'barbershop' check (business_type in ('barbershop', 'butchery')),
  phone_number_id text not null unique,
  display_phone_number text,
  timezone text not null default 'America/Santiago',
  currency text not null default 'CLP',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- People who take appointments (barbers today, other roles in later phases).
create table staff (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  personal_whatsapp text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index staff_shop_id_idx on staff(shop_id);

-- What can be booked (haircut, haircut + beard, etc).
create table services (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  duration_minutes int not null check (duration_minutes > 0),
  price numeric(10, 2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index services_shop_id_idx on services(shop_id);

-- Availability blocks per staff member.
create table schedules (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  staff_id uuid not null references staff(id) on delete cascade,
  date date not null,
  start_time time not null,
  end_time time not null,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

create index schedules_staff_date_idx on schedules(staff_id, date);

-- Booked appointments. start_time/end_time are full timestamps (not just a
-- time-of-day) so the exclusion constraint below can compare real ranges.
create table appointments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  staff_id uuid not null references staff(id) on delete cascade,
  service_id uuid not null references services(id),
  client_name text not null,
  client_phone text not null,
  date date not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  price numeric(10, 2) not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'no_show', 'completed')),
  reminder_24h_sent_at timestamptz,
  reminder_1h_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time),
  -- Anti double-booking: no two active appointments for the same staff member
  -- may have overlapping time ranges, regardless of each service's duration.
  exclude using gist (
    staff_id with =,
    tstzrange(start_time, end_time) with &&
  ) where (status in ('pending', 'confirmed'))
);

create index appointments_shop_date_idx on appointments(shop_id, date);
create index appointments_staff_date_idx on appointments(staff_id, date);

-- Phase 3: clients waiting for a slot to free up.
create table waitlist (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  client_phone text not null,
  service_id uuid references services(id),
  desired_date date not null,
  desired_time time,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index waitlist_shop_idx on waitlist(shop_id);

-- Conversation state per client, since serverless functions have no memory
-- between invocations. Expires after 30 minutes of inactivity.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  client_phone text not null,
  state jsonb not null default '{}'::jsonb,
  fallback_count int not null default 0,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  updated_at timestamptz not null default now(),
  unique (shop_id, client_phone)
);

-- Audit trail of every inbound/outbound WhatsApp message. Also used to avoid
-- sending the same reminder twice and to track delivery status.
create table message_logs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references shops(id) on delete set null,
  appointment_id uuid references appointments(id) on delete set null,
  client_phone text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  message_type text not null,
  template_name text,
  content jsonb,
  meta_message_id text,
  status text not null default 'sent' check (status in ('sent', 'delivered', 'read', 'failed')),
  created_at timestamptz not null default now()
);

create index message_logs_shop_idx on message_logs(shop_id);
create index message_logs_meta_message_id_idx on message_logs(meta_message_id);

-- Idempotency: Meta can redeliver the same webhook event more than once.
create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  meta_event_id text not null unique,
  event_type text not null check (event_type in ('message', 'status')),
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

-- RLS on everywhere. No policies yet: only the service role (used by the
-- backend) can read/write until Phase 4 adds shop-owner authentication.
alter table shops enable row level security;
alter table staff enable row level security;
alter table services enable row level security;
alter table schedules enable row level security;
alter table appointments enable row level security;
alter table waitlist enable row level security;
alter table sessions enable row level security;
alter table message_logs enable row level security;
alter table webhook_events enable row level security;
