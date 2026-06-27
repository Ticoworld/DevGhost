begin;

create index if not exists idx_draft_events_device_created_at
    on draft_events (device_id, created_at desc);

create index if not exists idx_draft_events_device_topic_angle
    on draft_events (device_id, topic_tag, angle, created_at desc);

create index if not exists idx_feedback_events_device_created_at
    on feedback_events (device_id, created_at desc);

create index if not exists idx_feedback_events_device_topic_angle
    on feedback_events (device_id, topic_tag, angle, created_at desc);

create index if not exists idx_topic_angle_memory_device_last_seen
    on topic_angle_memory (device_id, last_seen_at desc);

commit;
