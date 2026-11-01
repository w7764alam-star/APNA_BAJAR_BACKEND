import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import authR from "./auth.js";
import shopR from "./shop.js";
import ordersR from "./orders.js";
import meR from "./me.js";
import sellerR from "./seller.js";
import adminR from "./admin.js";
import aiR from "./ai.js";
import marketR from "./market.js";

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) { console.error("Set JWT_SECRET (32+ characters) in .env"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL in .env"); process.exit(1); }
const uploads = path.resolve(process.env.UPLOAD_DIR || "./uploads");
fs.mkdirSync(uploads, { recursive: true });

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean) }));
app.use(express.json({ limit: "100kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 300 }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, limit: 40 }));
app.use("/uploads", express.static(uploads, { setHeaders: r => r.setHeader("X-Content-Type-Options", "nosniff") }));
app.get("/health", (_q, r) => r.json({ ok: true }));
app.use("/api/auth", authR);
app.use("/api/ai", aiR);
app.use("/api", shopR);
app.use("/api", marketR);
app.use("/api", ordersR);
app.use("/api", meR);
app.use("/api/seller", sellerR);
app.use("/api/admin", adminR);
app.use((_q, r) => r.status(404).json({ error: "Not found" }));
app.use((e, _q, res, _n) => {
  const status = e.status || (e.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  if (status >= 500) console.error(e);
  res.status(status).json({ error: status < 500 ? e.message : "Server error" });
});
app.listen(process.env.PORT || 4000, () => console.log("APNA BAZAR API running on port " + (process.env.PORT || 4000)));
