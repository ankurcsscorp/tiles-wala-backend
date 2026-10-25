import "dotenv/config";
import express from "express";
import cors from "cors";
import enquiriesRouter from "./src/routes/enquries.js";
import authRouter from "./src/routes/auth.js";
import usersRouter from "./src/routes/users.js";
import salesBonusRouter from "./src/routes/salesBonus.js";
import collectionsRouter from "./src/routes/collections.js";
import storesRouter from "./src/routes/stores.js";
import productsRouter from "./src/routes/products.js";
import customersRouter from "./src/routes/customers.js";
import suppliersRouter from "./src/routes/suppliers.js";
import inventoryRouter from "./src/routes/inventory.js";
import purchasesRouter from "./src/routes/purchases.js";
import salesRouter from "./src/routes/sales.js";
import paymentsRouter from "./src/routes/payments.js";
import transfersRouter from "./src/routes/transfers.js";
import returnsRouter from "./src/routes/returns.js";
import financialReportsRouter from "./src/routes/financialReports.js";
import dashboardRouter from "./src/routes/dashboard.js";
import { connection } from "./connection.js";
import { assertAuthConfiguration } from "./src/controllers/auth.js";

import gstRouter from "./src/routes/gst.js";

const app = express();

app.disable("x-powered-by");
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:5173"
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(
  "/api/tiles/collections",
  express.json({ limit: "12mb" }),
  collectionsRouter
);
app.use(express.json({ limit: "20kb" }));

app.use("/api/tiles", enquiriesRouter);
app.use("/api/tiles/auth", authRouter);
app.use("/api/tiles/users", usersRouter);
app.use("/api/tiles/sales-bonus", salesBonusRouter);
app.use("/api/tiles/stores", storesRouter);
app.use("/api/tiles/products", productsRouter);
app.use("/api/gst", gstRouter);
app.use("/api/tiles/customers", customersRouter);
app.use("/api/tiles/suppliers", suppliersRouter);
app.use("/api/tiles/inventory", inventoryRouter);
app.use("/api/tiles/purchases", purchasesRouter);
app.use("/api/tiles/sales", salesRouter);
app.use("/api/tiles/payments", paymentsRouter);
app.use("/api/tiles/transfers", transfersRouter);
app.use("/api/tiles/returns", returnsRouter);
app.use("/api/tiles/financial-reports", financialReportsRouter);
app.use("/api/tiles/dashboard", dashboardRouter);

app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err.message);
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body exceeds the allowed size." });
  }
  return res.status(500).json({ message: "An unexpected server error occurred" });
});

const startServer = async () => {
  assertAuthConfiguration();
  const missingDatabaseSettings = [
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
  ].filter((setting) => !process.env[setting]);
  if (missingDatabaseSettings.length > 0) {
    throw new Error(
      `Missing required database settings: ${missingDatabaseSettings.join(", ")}`
    );
  }

  await connection.query("SELECT 1");
  await connection.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      mobile VARCHAR(20) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      area_location VARCHAR(200),
      user_type VARCHAR(30) NOT NULL CHECK (
        user_type IN ('Admin', 'Salesperson', 'Tile Mistire', 'Plumber Mistiri')
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS area_location VARCHAR(200)
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS tile_collections (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      featured_key VARCHAR(20),
      name VARCHAR(150) NOT NULL,
      size VARCHAR(80) NOT NULL,
      description VARCHAR(1000) NOT NULL,
      images JSONB NOT NULL CHECK (jsonb_typeof(images) = 'array'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await connection.query(`
    ALTER TABLE tile_collections
    ADD COLUMN IF NOT EXISTS featured_key VARCHAR(20)
  `);
  await connection.query(`
    DELETE FROM tile_collections older
    USING tile_collections newer
    WHERE older.featured_key IS NOT NULL
      AND older.featured_key = newer.featured_key
      AND (older.created_at, older.id) < (newer.created_at, newer.id)
  `);
  await connection.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tile_collections_featured_key_unique
    ON tile_collections (featured_key)
    WHERE featured_key IS NOT NULL
  `);

  await connection.query(`
    ALTER TABLE enquiry
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS sales_bonus_product_config (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      product_name VARCHAR(200) NOT NULL UNIQUE,
      default_cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      default_bonus_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
      unit_label VARCHAR(40) NOT NULL DEFAULT 'Box',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    INSERT INTO sales_bonus_product_config (product_name, default_cost_price, default_bonus_percentage, unit_label)
    SELECT seed.product_name, seed.default_cost_price, seed.default_bonus_percentage, seed.unit_label
    FROM (VALUES
      ('Antila 12x18 Wall Tiles', 210, 10, 'Box'),
      ('Antila 12x12 Floor Tiles', 230, 10, 'Box'),
      ('Coinn 2x2 Floor Tiles', 440, 10, 'Box'),
      ('Alaska 2x4 Gloss Tiles', 570, 10, 'Box'),
      ('Alaska 2x4 Carvin Tiles', 620, 10, 'Box'),
      ('Alaska 2x4 High gloss Tiles', 895, 10, 'Box'),
      ('Galaxy Black Granite', 160, 10, 'Box'),
      ('R Black Granite', 95, 10, 'Box'),
      ('P white Granite', 70, 10, 'Box'),
      ('M Black Granite', 95, 10, 'Box'),
      ('K Black Granite', 95, 10, 'Box'),
      ('R Brown Granite', 95, 10, 'Box'),
      ('Gem red Granite', 115, 10, 'Box')
    ) AS seed(product_name, default_cost_price, default_bonus_percentage, unit_label)
    WHERE NOT EXISTS (SELECT 1 FROM sales_bonus_product_config)
    ON CONFLICT (product_name) DO NOTHING;
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS sales_bonus_records (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      selected_user_type VARCHAR(30) NOT NULL,
      total_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_selling_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_gross_profit NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_gross_bonus NUMERIC(12,2) NOT NULL DEFAULT 0,
      final_user_bonus NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount_paid >= 0),
      payment_method VARCHAR(10) CHECK (payment_method IN ('UPI', 'CASH')),
      is_fully_paid BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    ALTER TABLE sales_bonus_records
    ADD COLUMN IF NOT EXISTS total_amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0
      CHECK (total_amount_paid >= 0),
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(10)
      CHECK (payment_method IN ('UPI', 'CASH')),
    ADD COLUMN IF NOT EXISTS is_fully_paid BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS sales_bonus_record_items (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sales_bonus_record_id BIGINT NOT NULL REFERENCES sales_bonus_records(id) ON DELETE CASCADE,
      product_name VARCHAR(200) NOT NULL,
      cost_price NUMERIC(12,2) NOT NULL,
      selling_price NUMERIC(12,2) NOT NULL,
      quantity NUMERIC(12,2) NOT NULL,
      total_cost NUMERIC(12,2) NOT NULL,
      total_selling_amount NUMERIC(12,2) NOT NULL,
      gross_profit NUMERIC(12,2) NOT NULL,
      bonus_percentage NUMERIC(5,2) NOT NULL,
      gross_bonus NUMERIC(12,2) NOT NULL,
      user_bonus NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
};

startServer().catch((err) => {
  console.error("Server startup failed:", err.message);
  connection.end().finally(() => {
    process.exitCode = 1;
  });
});
