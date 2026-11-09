UPDATE stores
SET dealer_transport_options=(
  SELECT jsonb_agg(
    CASE WHEN option->>'code'='THELA' THEN jsonb_set(option,'{label}','"Thela"'::jsonb) ELSE option END
    ORDER BY ordinal
  )
  FROM jsonb_array_elements(dealer_transport_options) WITH ORDINALITY AS items(option,ordinal)
)
WHERE dealer_transport_options @> '[{"code":"THELA","label":"CNG Auto"}]'::jsonb;

ALTER TABLE stores ALTER COLUMN dealer_transport_options SET DEFAULT '[{"code":"TOTO","label":"Toto","charge":400},{"code":"THELA","label":"Thela","charge":700},{"code":"PICKUP","label":"Pickup","charge":1000}]'::jsonb;
