-- Views default to SECURITY DEFINER: they run as the view owner and so ignore the
-- caller's RLS. question_top_answers reads question_answers, the answer key, which
-- meant anyone holding the anon key could read it through the view even though the
-- base table denied them. Verified before this migration: the anon role got back
-- the full answer row.
--
-- security_invoker makes a view run with the caller's privileges, so the policies on
-- the underlying tables apply. Requires Postgres 15+.

ALTER VIEW question_top_answers SET (security_invoker = true);
ALTER VIEW quiz_heights         SET (security_invoker = true);
