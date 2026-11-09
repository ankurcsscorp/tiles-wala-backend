ALTER TABLE stores
  ADD COLUMN dealer_transport_charge NUMERIC(18,2) NOT NULL DEFAULT 1000
    CHECK(dealer_transport_charge>=0);
