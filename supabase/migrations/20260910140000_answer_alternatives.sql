-- v0.9.2: a song question can accept more than one name for a field -- a title
-- with a second official spelling, or a song that sits on more than one record.
-- The key still enumerates every combination of the fields; this column only
-- says which field a single-name row is a name *for*, so the editor can group
-- the alternatives again when the day is reopened. NULL is everything else:
-- combinations, answers typed by hand, rarest keys and players' guesses.
--
-- 'full' is the one combination that is not simply its fields added up: the row
-- carrying the moderator's bonus for getting every field right. Reopening a day
-- read that bonus back off the row's tier -- which is also what a row with no
-- bonus is given, so a day reopened and saved grew a bonus nobody gave it.
ALTER TABLE question_answers
    ADD COLUMN field TEXT CHECK (field IN ('artist', 'title', 'album', 'full'));
