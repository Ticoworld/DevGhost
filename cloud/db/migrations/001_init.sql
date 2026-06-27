begin;

create table if not exists devices (
    id text primary key,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    first_seen_client_version text,
    last_seen_client_version text
);

create table if not exists draft_events (
    id text primary key,
    request_id text not null,
    device_id text not null references devices(id) on delete cascade,
    trigger_type text not null,
    topic_tag text not null,
    angle text not null,
    model_name text not null,
    draft_length_chars integer not null check (draft_length_chars >= 0),
    context_bytes integer not null check (context_bytes >= 0),
    excerpt_count integer not null check (excerpt_count >= 0),
    excerpt_chars integer not null check (excerpt_chars >= 0),
    client_version text,
    created_at timestamptz not null default now(),
    unique (device_id, request_id)
);

create table if not exists feedback_events (
    id text primary key,
    request_id text not null,
    device_id text not null references devices(id) on delete cascade,
    draft_event_id text not null references draft_events(id) on delete cascade,
    feedback_type text not null,
    trigger_type text not null,
    topic_tag text not null,
    angle text not null,
    dismiss_reason text,
    error_code text,
    client_version text,
    created_at timestamptz not null default now(),
    unique (device_id, request_id)
);

create table if not exists topic_angle_memory (
    device_id text not null references devices(id) on delete cascade,
    topic_tag text not null,
    angle text not null,
    success_count integer not null default 0,
    copied_count integer not null default 0,
    opened_x_count integer not null default 0,
    dismissed_count integer not null default 0,
    last_feedback_type text,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    primary key (device_id, topic_tag, angle)
);

commit;
