import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { q } from "./db.js";
import { wrap, parse, bad, auth, role } from "./lib.js";
const r = Router();
r.use(auth(), role("seller", "admin"));
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 5 },
  fileFilter: (_q, f, cb) => cb(EXT[f.mimetype] ? null : new Error("Only JPG, PNG or WebP images are allowed"), !!EXT[f.mimetype]),
});
const approved = (req, _res, next) => req.user.role === "admin" || req.user.seller_status === "approved" ? next() : next(Object.assign(new Error("Your seller account is awaiting admin approval"), { status: 403 }));
const fields = z.object({
  title: z.string().trim().min(4).max(120), category_id: z.coerce.number().int(), price: z.coerce.number().int().min(1).max(10_000_000),
  mrp: z.coerce.number().int().min(1).optional(), cond: z.enum(["New", "Used", "Refurbished"]), city: z.string().trim().min(2).max(60),
  description: z.string().trim().min(10).max(2000), stock: z.coerce.number().int().min(1).max(1000).default(1),
  negotiable: z.enum(["true", "false"]).default("false").transform(v => v === "true"), brand: z.string().trim().max(60).optional(), emoji: z.string().max(8).optional(),
});
const base = () => (process.env.PUBLIC_URL || "").replace(/\/$/, "") + "/uploads/";
// Checks the real file signature, then stores on Cloudinary (if configured) or local disk.
const MAGIC = (b, m) => m === "image/jpeg" ? b[0] === 0xFF && b[1] === 0xD8 : m === "image/png" ? b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])) : b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP";
async function saveImg(f) {
  if (!MAGIC(f.buffer, f.mimetype)) bad(400, "Invalid image file");
  const { CLOUDINARY_CLOUD_NAME: cn, CLOUDINARY_API_KEY: ak, CLOUDINARY_API_SECRET: as } = process.env;
  if (cn && ak && as) {
    const ts = Math.floor(Date.now() / 1000), fd = new FormData();
    fd.append("file", new Blob([f.buffer], { type: f.mimetype })); fd.append("api_key", ak); fd.append("timestamp", String(ts));
    fd.append("signature", crypto.createHash("sha1").update(`timestamp=${ts}${as}`).digest("hex"));
    const r = await fetch(`https://api.cloudinary.com/v1_1/${cn}/image/upload`, { method: "POST", body: fd });
    if (!r.ok) bad(502, "Image upload failed");
    return (await r.json()).secure_url;
  }
  const name = crypto.randomBytes(16).toString("hex") + EXT[f.mimetype];
  await fs.promises.writeFile(path.join(path.resolve(process.env.UPLOAD_DIR || "./uploads"), name), f.buffer);
  return base() + name;
}

r.get("/ads", wrap(async (req, res) => res.json((await q("SELECT * FROM products WHERE seller_id=$1 AND status<>'removed' ORDER BY created_at DESC", [req.user.id])).rows)));
r.post("/ads", approved, upload.array("images", 5), wrap(async (req, res) => {
  const d = parse(fields, req.body);
  const imgs = []; for (const f of req.files || []) imgs.push(await saveImg(f));
  const { rows } = await q("INSERT INTO products(seller_id,category_id,title,brand,description,price,mrp,stock,cond,city,emoji,images,negotiable) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
    [req.user.id, d.category_id, d.title, d.brand || req.user.shop_name, d.description, d.price, Math.max(d.mrp || d.price, d.price), d.stock, d.cond, d.city, d.emoji || "📦", JSON.stringify(imgs), d.negotiable]);
  res.status(201).json(rows[0]);
}));
r.patch("/ads/:id(\\d+)", approved, wrap(async (req, res) => {
  const d = parse(z.object({ title: z.string().trim().min(4).max(120).optional(), price: z.number().int().min(1).optional(), description: z.string().trim().min(10).max(2000).optional(), stock: z.number().int().min(0).optional(), action: z.enum(["pause", "activate", "sold"]).optional(), cond: z.enum(["New", "Used", "Refurbished"]).optional(), city: z.string().trim().min(2).max(60).optional() }), req.body);
  const status = d.action === "pause" ? "paused" : d.action === "activate" ? "active" : d.action === "sold" ? "sold" : null;
  const { rows } = await q("UPDATE products SET title=COALESCE($1,title),price=COALESCE($2,price),mrp=GREATEST(mrp,COALESCE($2,price)),description=COALESCE($3,description),stock=COALESCE($4,stock),status=COALESCE($5,status),cond=COALESCE($8,cond),city=COALESCE($9,city) WHERE id=$6 AND seller_id=$7 AND status<>'removed' RETURNING *", [d.title, d.price, d.description, d.stock, status, req.params.id, req.user.id, d.cond, d.city]);
  if (!rows[0]) bad(404, "Listing not found");
  res.json(rows[0]);
}));
r.delete("/ads/:id(\\d+)", wrap(async (req, res) => { await q("UPDATE products SET status='removed' WHERE id=$1 AND seller_id=$2", [req.params.id, req.user.id]); res.json({ ok: true }); }));
r.get("/orders", wrap(async (req, res) => res.json((await q("SELECT o.id,o.status,o.created_at,o.address->>'city' AS city,oi.title,oi.qty,oi.price FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.seller_id=$1 ORDER BY o.created_at DESC LIMIT 100", [req.user.id])).rows)));
r.get("/stats", wrap(async (req, res) => {
  const a = (await q("SELECT count(*) FILTER(WHERE status='active')::int active,count(*) FILTER(WHERE status='sold')::int sold,count(*) FILTER(WHERE status='paused')::int paused FROM products WHERE seller_id=$1", [req.user.id])).rows[0];
  const e = (await q("SELECT COALESCE(sum(oi.price*oi.qty),0)::int earnings,count(DISTINCT o.id)::int orders FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.seller_id=$1 AND o.status='delivered'", [req.user.id])).rows[0];
  const rt = (await q("SELECT round(avg(rv.stars),1) AS rating FROM reviews rv JOIN products p ON p.id=rv.product_id WHERE p.seller_id=$1 AND NOT rv.hidden", [req.user.id])).rows[0];
  res.json({ ...a, ...e, rating: rt.rating });
}));
r.get("/requests", wrap(async (_q, res) => res.json((await q("SELECT id,text,city,created_at FROM product_requests WHERE status='open' ORDER BY created_at DESC LIMIT 30")).rows)));
export default r;
