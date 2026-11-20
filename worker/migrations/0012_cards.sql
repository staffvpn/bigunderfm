-- Visual cards made in the admin "Карточки" tab. The PNG lives in R2 under cards/.
create table if not exists cards (
  id text primary key,
  type text not null,
  format text not null,
  title text not null default '',
  r2_key text not null,
  created_at text not null,
  sent_at text
);
create index if not exists cards_created on cards (created_at desc);
