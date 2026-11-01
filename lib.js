import jwt from "jsonwebtoken";
import { pool, q } from "./db.js";
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const bad = (s, m) => { throw new HttpError(s, m); };
export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) bad(400, r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
};
export const sign = u => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
// Loads the user from the database on every request, so blocked users lose access immediately.
export const auth = (required = true) => wrap(async (req, _res, next) => {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) { if (required) bad(401, "Login required"); return next(); }
  let id;
  try { id = jwt.verify(t, process.env.JWT_SECRET).id; } catch { bad(401, "Invalid or expired token"); }
  const { rows } = await q("SELECT id,name,mobile,email,role,shop_name,city,seller_status,blocked FROM users WHERE id=$1", [id]);
  const u = rows[0];
  if (!u) bad(401, "Account not found");
  if (u.blocked) bad(403, "Account suspended");
  req.user = u; next();
});
export const role = (...r) => (req, _res, next) => r.includes(req.user.role) ? next() : next(new HttpError(403, "Not allowed"));
export const notify = (uid, title, body, client = pool) => client.query("INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)", [uid, title, body]);
export const audit = (adminId, action, detail = {}) => q("INSERT INTO audit_logs(admin_id,action,detail) VALUES($1,$2,$3)", [adminId, action, detail]);
export const sendSms = async () => { bad(501, "SMS provider not implemented. Add your provider call in src/lib.js sendSms()."); };
// Prices always come from the database. Never trust totals sent by the frontend.
export const FREE_DELIVERY_ABOVE = 499, DELIVERY_FEE = 40;
export async function price(userId, lines, couponCode, client = pool) {
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  let discount = 0, coupon = null;
  if (couponCode) {
    const { rows } = await client.query("SELECT * FROM coupons WHERE code=$1 AND active AND (expires_at IS NULL OR expires_at>now()) AND (usage_limit IS NULL OR used_count<usage_limit)", [couponCode.toUpperCase()]);
    const c = rows[0];
    if (!c) bad(400, "Invalid or expired coupon");
    if (subtotal < c.min_amount) bad(400, `Add items worth ₹${c.min_amount} to use this coupon`);
    if (c.first_order_only) {
      const o = await client.query("SELECT 1 FROM orders WHERE user_id=$1 AND status<>'cancelled' LIMIT 1", [userId]);
      if (o.rowCount) bad(400, "This coupon is only for your first order");
    }
    discount = c.kind === "percent" ? Math.floor(subtotal * c.value / 100) : Math.min(c.value, subtotal);
    coupon = c.code;
  }
  const delivery = subtotal && subtotal - discount < FREE_DELIVERY_ABOVE ? DELIVERY_FEE : 0;
  return { subtotal, discount, delivery, total: subtotal - discount + delivery, coupon };
}

// Group-buy: members of a deal that reached its target pay the group price (never trusted from the frontend).
export async function groupPrices(client, userId, lines) {
  if (!userId || !lines.length) return lines;
  const { rows } = await client.query("SELECT gd.product_id,gd.group_price FROM group_deals gd JOIN group_members gm ON gm.deal_id=gd.id WHERE gm.user_id=$1 AND gd.reached AND gd.active AND gd.ends_at>now() AND gd.product_id=ANY($2)", [userId, lines.map(l => l.product_id)]);
  for (const g of rows) { const l = lines.find(x => x.product_id === g.product_id); if (l && g.group_price < l.price) l.price = g.group_price; }
  return lines;
}
