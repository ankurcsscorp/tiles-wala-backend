DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE user_type = 'Dealer') THEN
    RAISE EXCEPTION 'Dealer accounts exist; migrate them before rolling back';
  END IF;
END $$;

ALTER TABLE users
  DROP CONSTRAINT users_user_type_check,
  ADD CONSTRAINT users_user_type_check
    CHECK (user_type IN ('Admin', 'Salesperson', 'Tile Mistire', 'Plumber Mistiri'));
