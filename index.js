import express from "express";
import cors from "cors";
import enquiriesRouter from "./src/routes/enquries.js";
const app = express();

app.use(cors({
    origin: [
        "http://localhost:3000",
        "http://localhost:5173"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

app.use("/api/tiles", enquiriesRouter);

app.listen(4000, () => {
  console.log("Server is running on port 4000");
});
