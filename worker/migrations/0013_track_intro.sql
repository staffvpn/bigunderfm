-- A copy of the track with a voice intro baked over its opening, served from the site's static files.
alter table tracks add column intro_path text;
