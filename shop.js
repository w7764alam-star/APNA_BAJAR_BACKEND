import { Router } from "express";
import { z } from "zod";
import { q, tx } from "./db.js";
import { wrap, parse, bad, auth, price, notify, groupPrices } from "./lib.js";
const r = Router();
const SORTS = { relevance: "p.created_at DESC", newest: "p.created_at DESC", price_asc: "p.price ASC", price_desc: "p.price DESC", discount: "(p.mrp-p.price)::float/p.mrp DESC", rating: "rating DESC NULLS LAST" };
const SELECT = `SELECT p.id,p.title,p.brand,p.description,p.price,p.mrp,p.stock,p.cond,p.city,p.emoji,p.images,p.negotiable,p.status,p.is_demo,p.created_at,p.seller_id,
 c.name AS category,pc.name AS parent_category,u.shop_name AS seller_shop,u.verified AS seller_verified,(SELECT round(avg(rv2.stars),1) FROM reviews rv2 JOIN products sp ON sp.id=rv2.product_id WHERE sp.seller_id=p.seller_id AND NOT rv2.hidden) AS seller_rating,
 (SELECT round(avg(stars),1) FROM reviews rv WHERE rv.product_id=p.id AND NOT rv.hidden) AS rating,
 (SELECT count(*)::int FROM reviews rv WHERE rv.product_id=p.id AND NOT rv.hidden) AS review_count
 FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN users u ON u.id=p.seller_id LEFT JOIN categories pc ON pc.id=c.parent_id`;

r.get("/config", (_q, res) => res.json({ razorpay: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET), ai: !!process.env.ANTHROPIC_API_KEY, googleClientId: process.env.GOOGLE_CLIENT_ID || null }));
r.get("/categories", wrap(async (_q, res) => res.json((await q("SELECT c.id,c.name,c.icon,c.parent_id,count(p.id)::int AS products FROM categories c LEFT JOIN products p ON p.category_id=c.id AND p.status='active' GROUP BY c.id ORDER BY c.id")).rows)));
r.get("/banners", wrap(async (_q, res) => res.json((await q("SELECT id,text,link FROM banners WHERE active ORDER BY id DESC")).rows)));

r.get("/products", wrap(async (req, res) => {
  const f = parse(z.object({
    q: z.string().max(80).optional(), category: z.coerce.number().int().optional(), brand: z.string().max(60).optional(),
    min: z.coerce.number().int().min(0).optional(), max: z.coerce.number().int().min(0).optional(),
    cond: z.enum(["New", "Used", "Refurbished"]).optional(), city: z.string().max(60).optional(), inStock: z.enum(["1"]).optional(),
    minDiscount: z.coerce.number().int().min(0).max(90).optional(), minRating: z.coerce.number().min(0).max(5).optional(),
    seller: z.coerce.number().int().optional(),
    sort: z.enum(Object.keys(SORTS)).default("relevance"), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20),
  }), req.query);
  const where = ["p.status='active'"], args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replaceAll("?", "$" + args.length)); };
  if (f.q) add("(p.title ILIKE ? OR p.brand ILIKE ? OR c.name ILIKE ?)", `%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
  if (f.category) add("(p.category_id=? OR c.parent_id=?)", f.category);
  if (f.brand) add("p.brand=?", f.brand);
  if (f.min !== undefined) add("p.price>=?", f.min);
  if (f.max !== undefined) add("p.price<=?", f.max);
  if (f.cond) add("p.cond=?", f.cond);
  if (f.city) add("lower(p.city)=lower(?)", f.city);
  if (f.seller) add("p.seller_id=?", f.seller);
  if (f.inStock) where.push("p.stock>0");
  if (f.minDiscount) add("(p.mrp-p.price)*100>=?*p.mrp", f.minDiscount);
  if (f.minRating) add("COALESCE((SELECT avg(stars) FROM reviews rv WHERE rv.product_id=p.id AND NOT rv.hidden),0)>=?", f.minRating);
  const W = where.join(" AND ");
  const total = (await q(`SELECT count(*)::int n FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${W}`, args)).rows[0].n;
  const items = (await q(`${SELECT} WHERE ${W} ORDER BY ${SORTS[f.sort]} LIMIT ${f.limit} OFFSET ${(f.page - 1) * f.limit}`, args)).rows;
  res.json({ items, page: f.page, limit: f.limit, total });
}));
r.get("/search/suggest", wrap(async (req, res) => {
  const s = String(req.query.q || "").slice(0, 60).trim();
  if (s.length < 2) return res.json([]);
  res.json((await q("SELECT DISTINCT title FROM products WHERE status='active' AND title ILIKE $1 LIMIT 8", [`%${s.replace(/[\\%_]/g, "\\$&")}%`])).rows.map(x => x.title));
}));
r.get("/products/:id(\\d+)", wrap(async (req, res) => {
  const p = (await q(`${SELECT} WHERE p.id=$1 AND p.status<>'removed'`, [req.params.id])).rows[0];
  if (!p) bad(404, "Product not found");
  const related = (await q(`${SELECT} WHERE p.status='active' AND p.id<>$1 AND p.category_id=(SELECT category_id FROM products WHERE id=$1) ORDER BY p.created_at DESC LIMIT 6`, [p.id])).rows;
  res.json({ product: p, related });
}));

// Cart (stored on the server, linked to the logged-in user)
async function cartLines(uid) {
  return (await q("SELECT ci.product_id,ci.qty,p.title,p.price,p.mrp,p.stock,p.emoji,p.images FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.user_id=$1 AND p.status='active' ORDER BY p.title", [uid])).rows;
}
r.get("/cart", auth(), wrap(async (req, res) => {
  const lines = await groupPrices({ query: q }, req.user.id, await cartLines(req.user.id));
  let summary; try { summary = await price(req.user.id, lines, req.query.coupon ? String(req.query.coupon) : null); } catch (e) { if (e.status !== 400) throw e; summary = { ...(await price(req.user.id, lines, null)), couponError: e.message }; }
  res.json({ items: lines, summary });
}));
r.put("/cart/:pid(\\d+)", auth(), wrap(async (req, res) => {
  const { qty } = parse(z.object({ qty: z.number().int().min(0).max(20) }), req.body);
  if (qty === 0) await q("DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2", [req.user.id, req.params.pid]);
  else {
    const p = (await q("SELECT stock,status,seller_id FROM products WHERE id=$1", [req.params.pid])).rows[0];
    if (!p || p.status !== "active") bad(404, "Product not available");
    if (p.seller_id === req.user.id) bad(400, "You cannot buy your own listing");
    if (qty > p.stock) bad(409, `Only ${p.stock} in stock`);
    await q("INSERT INTO cart_items(user_id,product_id,qty) VALUES($1,$2,$3) ON CONFLICT(user_id,product_id) DO UPDATE SET qty=$3", [req.user.id, req.params.pid, qty]);
  }
  res.json({ ok: true });
}));
r.delete("/cart", auth(), wrap(async (req, res) => { await q("DELETE FROM cart_items WHERE user_id=$1", [req.user.id]); res.json({ ok: true }); }));

// Wishlist
r.get("/wishlist", auth(), wrap(async (req, res) => res.json((await q(`${SELECT} JOIN wishlist w ON w.product_id=p.id WHERE w.user_id=$1 AND p.status<>'removed'`, [req.user.id])).rows)));
r.put("/wishlist/:pid(\\d+)", auth(), wrap(async (req, res) => { await q("INSERT INTO wishlist(user_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.user.id, req.params.pid]); res.json({ ok: true }); }));
r.delete("/wishlist/:pid(\\d+)", auth(), wrap(async (req, res) => { await q("DELETE FROM wishlist WHERE user_id=$1 AND product_id=$2", [req.user.id, req.params.pid]); res.json({ ok: true }); }));

// Reviews: only verified buyers (non-cancelled order containing the product)
r.get("/products/:id(\\d+)/reviews", wrap(async (req, res) => res.json((await q("SELECT rv.stars,rv.body,rv.created_at,u.name,rv.user_id FROM reviews rv JOIN users u ON u.id=rv.user_id WHERE rv.product_id=$1 AND NOT rv.hidden ORDER BY rv.created_at DESC LIMIT 100", [req.params.id])).rows.map(x => ({ ...x, verified_purchase: true })))));
r.put("/products/:id(\\d+)/reviews", auth(), wrap(async (req, res) => {
  const d = parse(z.object({ stars: z.number().int().min(1).max(5), body: z.string().trim().min(5).max(1000) }), req.body);
  const ok = await q("SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.user_id=$1 AND oi.product_id=$2 AND o.status NOT IN('cancelled','pending') LIMIT 1", [req.user.id, req.params.id]);
  if (!ok.rowCount) bad(403, "Only customers who bought this product can review it");
  await q("INSERT INTO reviews(product_id,user_id,stars,body) VALUES($1,$2,$3,$4) ON CONFLICT(product_id,user_id) DO UPDATE SET stars=$3,body=$4,created_at=now()", [req.params.id, req.user.id, d.stars, d.body]);
  res.json({ ok: true });
}));
r.post("/products/:id(\\d+)/report", auth(), wrap(async (req, res) => {
  const d = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  await q("INSERT INTO reports(product_id,reporter_id,reason) VALUES($1,$2,$3)", [req.params.id, req.user.id, d.reason]);
  res.status(201).json({ ok: true });
}));

// Group buying
r.get("/groups", auth(false), wrap(async (req, res) => res.json((await q(`SELECT gd.id,gd.target,gd.group_price,gd.ends_at,gd.reached,p.id AS product_id,p.title,p.price,p.emoji,
 (SELECT count(*)::int FROM group_members m WHERE m.deal_id=gd.id) AS joined,
 EXISTS(SELECT 1 FROM group_members m WHERE m.deal_id=gd.id AND m.user_id=$1) AS member
 FROM group_deals gd JOIN products p ON p.id=gd.product_id WHERE gd.active AND gd.ends_at>now() AND p.status='active' ORDER BY gd.ends_at`, [req.user ? req.user.id : 0])).rows)));
r.post("/groups/:id(\\d+)/join", auth(), wrap(async (req, res) => {
  await tx(async c => {
    const d = (await c.query("SELECT * FROM group_deals WHERE id=$1 AND active AND ends_at>now() FOR UPDATE", [req.params.id])).rows[0];
    if (!d) bad(404, "Deal not found or ended");
    await c.query("INSERT INTO group_members(deal_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [d.id, req.user.id]);
    const n = (await c.query("SELECT count(*)::int n FROM group_members WHERE deal_id=$1", [d.id])).rows[0].n;
    if (!d.reached && n >= d.target) {
      await c.query("UPDATE group_deals SET reached=true WHERE id=$1", [d.id]);
      for (const m of (await c.query("SELECT user_id FROM group_members WHERE deal_id=$1", [d.id])).rows) await notify(m.user_id, "Group deal unlocked", "The group price is now active for you. Add the product to your cart.", c);
    }
  });
  res.json({ ok: true });
}));
// Product requests ("I want this product but nobody sells it")
r.post("/requests", auth(), wrap(async (req, res) => {
  const d = parse(z.object({ text: z.string().trim().min(5).max(300), city: z.string().trim().max(60).optional() }), req.body);
  await q("INSERT INTO product_requests(user_id,text,city) VALUES($1,$2,$3)", [req.user.id, d.text, d.city || null]);
  res.status(201).json({ ok: true });
}));
r.get("/requests/mine", auth(), wrap(async (req, res) => res.json((await q("SELECT id,text,city,status,created_at FROM product_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [req.user.id])).rows)));

export default r;
