-- Broadcasts sent from the admin "Управление" tab, remembered so the bot can
-- delete its own copy of each message once it expires (see deleteExpiredNotifications).
create table sent_notifications (
  chat_id integer not null,
  message_id integer not null,
  delete_at text not null,
  primary key (chat_id, message_id)
);

create index sent_notifications_delete_at on sent_notifications (delete_at);
