-- Players get questions from the backend, one at a time and without track ids.
-- The anon read policy on questions handed out all seven prompts plus track_id
-- (joinable to tracks.title) for any published quiz through PostgREST.
-- Moderators keep access through mod_write.
DROP POLICY read_published ON questions;
