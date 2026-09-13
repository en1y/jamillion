-- Copied to /etc/postgresql.schema.sql (docker/db.Dockerfile), which the Supabase postgres image runs
-- once, at the end of initdb. The same passwords the CLI sets, from the one
-- generated on first boot (docker/setup.py) instead of "postgres".
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER postgres WITH PASSWORD :'pgpass';
ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_replication_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_read_only_user WITH PASSWORD :'pgpass';
