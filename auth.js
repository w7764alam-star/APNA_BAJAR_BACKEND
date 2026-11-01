import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { q } from "./db.js";
import { wrap, parse, bad, sign, auth, sendSms, audit } from "./lib.js";
const r = Router();
const mobile = z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number");
const password = z.string().min(8, "Password needs at least 8 characters").max(100);
const hashOtp = (m, c) => crypto.createHash("sha256").update(m + c + process.env.JWT_SECRET).digest("hex");

r.post("/register", wrap(async (req, res) => {
  const d = parse(z.object({
    name: z.string().trim().min(2).max(80), mobile, password,
    email: z.string().email().optional().or(z.literal("")),
    role: z.enum(["customer", "seller"]).default("customer"),
    shop_name: z.string().trim().min(2).max(80).optional(), city: z.string().trim().min(2).max(60).optional(),
  }), req.body);
  if (d.role === "seller" && (!d.shop_name || !d.city)) bad(400, "Shop name and city are required for sellers");
  const status = d.role === "seller" && process.env.REQUIRE_SELLER_APPROVAL === "true" ? "pending" : "approved";
  try {
    const { rows } = await q("INSERT INTO users(name,mobile,email,password_hash,role,shop_name,city,seller_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,mobile,role,shop_name,city,seller_status",
      [d.name, d.mobile, d.email || null, await bcrypt.hash(d.password, 12), d.role, d.shop_name || null, d.city || null, status]);
    res.status(201).json({ user: rows[0], token: sign(rows[0]) });
  } catch (e) { if (e.code === "23505") bad(409, "This mobile number is already registered"); throw e; }
}));

r.post("/login", wrap(async (req, res) => {
  const d = parse(z.object({ mobile, password: z.string().min(1).max(100) }), req.body);
  const { rows } = await q("SELECT * FROM users WHERE mobile=$1", [d.mobile]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(d.password, u.password_hash))) bad(401, "Wrong mobile number or password");
  if (u.blocked) bad(403, "Account suspended");
  res.json({ user: { id: u.id, name: u.name, mobile: u.mobile, role: u.role, shop_name: u.shop_name, city: u.city, seller_status: u.seller_status }, token: sign(u) });
}));

async function sendOtp(m) {
  const code = String(crypto.randomInt(100000, 1000000));
  await q("INSERT INTO otps(mobile,code_hash,expires_at,attempts) VALUES($1,$2,now()+interval '5 minutes',0) ON CONFLICT(mobile) DO UPDATE SET code_hash=$2,expires_at=now()+interval '5 minutes',attempts=0", [m, hashOtp(m, code)]);
  if (process.env.SMS_PROVIDER) { await sendSms(m, code); return {}; }
  if (process.env.NODE_ENV !== "production") return { devOtp: code, note: "Development mode: no SMS provider configured" };
  bad(503, "SMS provider not configured");
}
async function checkOtp(m, code) {
  const { rows } = await q("SELECT * FROM otps WHERE mobile=$1", [m]);
  const o = rows[0];
  if (!o || new Date(o.expires_at) < new Date() || o.attempts >= 5) bad(400, "OTP expired. Request a new one");
  const ok = crypto.timingSafeEqual(Buffer.from(o.code_hash), Buffer.from(hashOtp(m, code)));
  if (!ok) { await q("UPDATE otps SET attempts=attempts+1 WHERE mobile=$1", [m]); bad(400, "Wrong OTP"); }
  await q("DELETE FROM otps WHERE mobile=$1", [m]);
}
r.post("/otp/send", wrap(async (req, res) => res.json({ ok: true, ...(await sendOtp(parse(z.object({ mobile }), req.body).mobile)) })));
r.post("/otp/login", wrap(async (req, res) => {
  const d = parse(z.object({ mobile, code: z.string().length(6) }), req.body);
  await checkOtp(d.mobile, d.code);
  const { rows } = await q("SELECT id,name,mobile,role,shop_name,city,seller_status,blocked FROM users WHERE mobile=$1", [d.mobile]);
  if (!rows[0]) bad(404, "No account for this number. Register first");
  if (rows[0].blocked) bad(403, "Account suspended");
  res.json({ user: rows[0], token: sign(rows[0]) });
}));
r.post("/password/reset", wrap(async (req, res) => {
  const d = parse(z.object({ mobile, code: z.string().length(6), password }), req.body);
  await checkOtp(d.mobile, d.code);
  await q("UPDATE users SET password_hash=$1 WHERE mobile=$2", [await bcrypt.hash(d.password, 12), d.mobile]);
  res.json({ ok: true });
}));
r.get("/me", auth(), (req, res) => res.json({ user: req.user }));
r.patch("/me", auth(), wrap(async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), email: z.string().email().optional(), city: z.string().trim().max(60).optional(), shop_name: z.string().trim().max(80).optional() }), req.body);
  const { rows } = await q("UPDATE users SET name=COALESCE($1,name),email=COALESCE($2,email),city=COALESCE($3,city),shop_name=COALESCE($4,shop_name) WHERE id=$5 RETURNING id,name,mobile,email,role,shop_name,city", [d.name, d.email, d.city, d.shop_name, req.user.id]);
  res.json({ user: rows[0] });
}));
r.post("/password/change", auth(), wrap(async (req, res) => {
  const d = parse(z.object({ current: z.string(), password }), req.body);
  const { rows } = await q("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
  if (!(await bcrypt.compare(d.current, rows[0].password_hash))) bad(400, "Current password is wrong");
  await q("UPDATE users SET password_hash=$1 WHERE id=$2", [await bcrypt.hash(d.password, 12), req.user.id]);
  res.json({ ok: true });
}));
r.post("/delete-request", auth(), wrap(async (req, res) => { await audit(null, "account.delete_request", { userId: req.user.id, mobile: req.user.mobile }); res.json({ ok: true }); }));
// Google sign-in: the ID token is verified with Google; only customer accounts are created this way.
r.post("/google", wrap(async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) bad(503, "Google login is not configured");
  const d = parse(z.object({ credential: z.string().min(20).max(4000) }), req.body);
  const resp = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(d.credential));
  if (!resp.ok) bad(401, "Google sign-in failed");
  const g = await resp.json();
  if (g.aud !== process.env.GOOGLE_CLIENT_ID || String(g.email_verified) !== "true" || !["accounts.google.com", "https://accounts.google.com"].includes(g.iss)) bad(401, "Google sign-in failed");
  let u = (await q("SELECT id,name,mobile,email,role,shop_name,city,seller_status,blocked FROM users WHERE google_sub=$1", [g.sub])).rows[0];
  if (!u) u = (await q("INSERT INTO users(name,email,role,google_sub) VALUES($1,$2,'customer',$3) RETURNING id,name,mobile,email,role,shop_name,city,seller_status,blocked", [g.name || g.email, g.email, g.sub])).rows[0];
  if (u.blocked) bad(403, "Account suspended");
  res.json({ user: u, token: sign(u) });
}));
export default r;
