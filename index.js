import "dotenv/config";
import express from "express";
import cors from "cors";
import enquiriesRouter from "./src/routes/enquries.js";
import authRouter from "./src/routes/auth.js";
import { connection } from "./connection.js";
import { assertAuthConfiguration } from "./src/controllers/auth.js";

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
app.use(express.json({ limit: "20kb" }));

app.use("/api/tiles", enquiriesRouter);
app.use("/api/tiles/auth", authRouter);

app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err.message);
  if (res.headersSent) return next(err);
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
      user_type VARCHAR(30) NOT NULL CHECK (
        user_type IN ('Admin', 'Salesperson', 'Tile Mistire', 'Plumber Mistiri')
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
