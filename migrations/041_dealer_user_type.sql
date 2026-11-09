ALTER TABLE users
  DROP CONSTRAINT users_user_type_check,
  ADD CONSTRAINT users_user_type_check
    CHECK (user_type IN ('Admin', 'Salesperson', 'Tile Mistire', 'Plumber Mistiri', 'Dealer'));
