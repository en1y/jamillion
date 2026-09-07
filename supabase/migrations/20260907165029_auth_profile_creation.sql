-- Serialize account bootstrap so exactly one first signup receives admin.
-- Also handle blank names and any number of duplicate requested usernames.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    base_name TEXT;
    uname TEXT;
    suffix INTEGER := 0;
BEGIN
    PERFORM pg_advisory_xact_lock(720020); -- shared by all profile-creation triggers
    base_name := left(coalesce(nullif(btrim(NEW.raw_user_meta_data->>'username'), ''),
                               nullif(split_part(NEW.email, '@', 1), ''), 'player'), 40);
    uname := base_name;
    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = uname) LOOP
        suffix := suffix + 1;
        uname := base_name || '-' || suffix;
    END LOOP;
    INSERT INTO public.profiles (id, username, role)
    VALUES (NEW.id, uname,
            CASE WHEN NOT EXISTS (SELECT 1 FROM public.profiles) THEN 'admin'::user_role
                 ELSE 'user'::user_role END);
    RETURN NEW;
END $$;
