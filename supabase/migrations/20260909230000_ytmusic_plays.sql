-- YouTube Music's own numbers, which are not the YouTube Data API's.
--
-- tracks.youtube_views is one video's view count. YouTube Music shows a song
-- figure instead: plays summed over every upload of that recording (official
-- video, art track, lyric video ...), so "3B plays" for a song whose art track
-- alone has 280M views. It is displayed rounded ("3B", "282M"), and is stored as
-- read -- three significant digits at best, exact enough to rank by.
ALTER TABLE tracks  ADD COLUMN ytmusic_plays     BIGINT;   -- YouTube Music song plays
ALTER TABLE artists ADD COLUMN ytmusic_listeners BIGINT;   -- YouTube Music monthly listeners

-- ytmusic_id now holds the YouTube Music artist page id (the browseId behind
-- music.youtube.com/channel/...), not the "- Topic" upload channel the seeder
-- briefly cached there; the two are different channels for the same artist.
UPDATE artists SET ytmusic_id = NULL;
