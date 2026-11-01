import { Router } from "express";
import { z } from "zod";
import { q, tx } from "./db.js";
import { wrap, parse, bad, auth, role, notify, audit } from "./lib.js";
const r = Router();
// Every admin route is checked on the server: valid login AND role = admin.
r.use(auth(), role("admin"));
const STATUS = ["confirmed", "processing", "shipped", "out_for_delivery", "delivered", "cancelled", "returned"];
const id = z.coerce.number().int();

r.get("/stats", wrap(async (_q, res) => {
  const s = (await q(`SELECT (SELECT count(*)::int FROM users WHERE role='customer') customers,
   (SELECT count(*)::int FROM users WHERE role='seller' AND seller_status='approved') active_sellers,
   (SELECT count(*)::int FROM products WHERE status='active') products,
   (SELECT count(*)::int FROM orders) orders,
   (SELECT count(*)::int FROM orders WHERE status IN('confirmed','processing')) pending_orders,
   (SELECT COALESCE(sum(total),0)::int FROM orders WHERE status NOT IN('cancelled','returned') AND (payment_status='paid' OR payment_method='cod')) revenue,
   (SELECT count(*)::int FROM reports WHERE NOT resolved) open_reports`)).rows[0];
  res.json(s);
}));
r.get("/users", wrap(async (req, res) => res.json((await q("SELECT id,name,mobile,role,shop_name,city,seller_status,blocked,verified,created_at FROM users WHERE ($1::text IS NULL OR role=$1) ORDER BY id DESC LIMIT 200", [req.query.role || null])).rows)));
r.patch("/users/:id", wrap(async (req, res) => {
  const d = parse(z.object({ blocked: z.boolean().optional(), seller_status: z.enum(["pending", "approved", "rejected"]).optional(), verified: z.boolean().optional() }), req.body);
  if (Number(req.params.id) === req.user.id) bad(400, "You cannot change your own account here");
  const { rows } = await q("UPDATE users SET blocked=COALESCE($1,blocked),seller_status=COALESCE($2,seller_status),verified=COALESCE($4,verified) WHERE id=$3 AND role<>'admin' RETURNING id,blocked,seller_status,verified", [d.blocked, d.seller_status, req.params.id, d.verified]);
  if (!rows[0]) bad(404, "User not found");
  await audit(req.user.id, "user.update", { userId: rows[0].id, ...d });
  if (d.seller_status) await notify(rows[0].id, "Seller application", `Your seller account is now ${d.seller_status}`);
  res.json(rows[0]);
}));

r.get("/products", wrap(async (_q, res) => res.json((await q("SELECT p.*,u.shop_name FROM products p LEFT JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC LIMIT 300")).rows)));
const prod = z.object({ title: z.string().trim().min(2).max(120), brand: z.string().max(60).optional(), category_id: z.number().int(), price: z.number().int().min(1), mrp: z.number().int().min(1), stock: z.number().int().min(0), cond: z.enum(["New", "Used", "Refurbished"]).default("New"), city: z.string().max(60).optional(), description: z.string().max(2000).optional(), emoji: z.string().max(8).optional() });
r.post("/products", wrap(async (req, res) => {
  const d = parse(prod, req.body);
  const { rows } = await q("INSERT INTO products(category_id,title,brand,description,price,mrp,stock,cond,city,emoji) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [d.category_id, d.title, d.brand, d.description, d.price, Math.max(d.mrp, d.price), d.stock, d.cond, d.city, d.emoji || "📦"]);
  await audit(req.user.id, "product.create", { id: rows[0].id });
  res.status(201).json(rows[0]);
}));
r.patch("/products/:id", wrap(async (req, res) => {
  const d = parse(z.object({ price: z.number().int().min(1).optional(), mrp: z.number().int().min(1).optional(), stock: z.number().int().min(0).optional(), status: z.enum(["active", "paused", "sold", "removed"]).optional(), title: z.string().min(2).max(120).optional() }), req.body);
  const { rows } = await q("UPDATE products SET price=COALESCE($1,price),mrp=GREATEST(COALESCE($2,mrp),COALESCE($1,price)),stock=COALESCE($3,stock),status=COALESCE($4,status),title=COALESCE($5,title) WHERE id=$6 RETURNING *", [d.price, d.mrp, d.stock, d.status, d.title, req.params.id]);
  if (!rows[0]) bad(404, "Product not found");
  await audit(req.user.id, "product.update", { id: rows[0].id, ...d });
  res.json(rows[0]);
}));
r.delete("/products/:id", wrap(async (req, res) => { await q("UPDATE products SET status='removed' WHERE id=$1", [req.params.id]); await audit(req.user.id, "product.remove", { id: req.params.id }); res.json({ ok: true }); }));

r.post("/categories", wrap(async (req, res) => { const d = parse(z.object({ name: z.string().trim().min(2).max(60), icon: z.string().max(8).optional(), parent_id: z.number().int().optional() }), req.body); const { rows } = await q("INSERT INTO categories(name,icon,parent_id) VALUES($1,$2,$3) RETURNING *", [d.name, d.icon || "📦", d.parent_id || null]); await audit(req.user.id, "category.create", d); res.status(201).json(rows[0]); }));
r.patch("/categories/:id", wrap(async (req, res) => { const d = parse(z.object({ name: z.string().trim().min(2).max(60).optional(), icon: z.string().max(8).optional() }), req.body); const { rows } = await q("UPDATE categories SET name=COALESCE($1,name),icon=COALESCE($2,icon) WHERE id=$3 RETURNING *", [d.name, d.icon, req.params.id]); if (!rows[0]) bad(404, "Category not found"); await audit(req.user.id, "category.update", d); res.json(rows[0]); }));
r.delete("/categories/:id", wrap(async (req, res) => {
  if ((await q("SELECT 1 FROM products WHERE category_id=$1 LIMIT 1", [req.params.id])).rowCount) bad(409, "Move or remove the products in this category first");
  await q("DELETE FROM categories WHERE id=$1", [req.params.id]); await audit(req.user.id, "category.delete", { id: req.params.id }); res.json({ ok: true });
}));

r.get("/orders", wrap(async (req, res) => res.json((await q("SELECT o.id,o.status,o.total,o.payment_method,o.payment_status,o.created_at,o.address,u.name AS customer,r.status AS return_status FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN returns r ON r.order_id=o.id WHERE ($1::text IS NULL OR o.status=$1) ORDER BY o.created_at DESC LIMIT 200", [req.query.status || null])).rows)));
r.patch("/orders/:id/status", wrap(async (req, res) => {
  const d = parse(z.object({ status: z.enum(STATUS) }), req.body);
  await tx(async c => {
    const o = (await c.query("SELECT user_id,status FROM orders WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
    if (!o) bad(404, "Order not found");
    if (d.status === "cancelled" && !["confirmed", "processing"].includes(o.status)) bad(400, "Only unshipped orders can be cancelled");
    if (d.status === "cancelled") {
      for (const i of (await c.query("SELECT product_id,qty FROM order_items WHERE order_id=$1", [req.params.id])).rows) await c.query("UPDATE products SET stock=stock+$1,status=CASE WHEN status='sold' THEN 'active' ELSE status END WHERE id=$2", [i.qty, i.product_id]);
    }
    await c.query("UPDATE orders SET status=$1,payment_status=CASE WHEN $1='cancelled' AND payment_status='paid' THEN 'refund_pending' WHEN $1='delivered' AND payment_method='cod' THEN 'paid' ELSE payment_status END,updated_at=now() WHERE id=$2", [d.status, req.params.id]);
    await notify(o.user_id, "Order update", `Order #${req.params.id} is now ${d.status.replaceAll("_", " ")}`, c);
  });
  await audit(req.user.id, "order.status", { id: req.params.id, ...d });
  res.json({ ok: true });
}));
r.patch("/returns/:orderId", wrap(async (req, res) => {
  const d = parse(z.object({ status: z.enum(["approved", "picked_up", "refunded", "rejected"]) }), req.body);
  const { rows } = await q("UPDATE returns SET status=$1 WHERE order_id=$2 RETURNING order_id", [d.status, req.params.orderId]);
  if (!rows[0]) bad(404, "Return not found");
  // NOTE: for online payments, call the Razorpay refund API here before marking 'refunded'.
  if (d.status === "refunded") await q("UPDATE orders SET status='returned',payment_status='refunded',updated_at=now() WHERE id=$1", [req.params.orderId]);
  const o = (await q("SELECT user_id FROM orders WHERE id=$1", [req.params.orderId])).rows[0];
  await notify(o.user_id, "Return update", `Return for order #${req.params.orderId}: ${d.status.replace("_", " ")}`);
  await audit(req.user.id, "return.update", { orderId: req.params.orderId, ...d });
  res.json({ ok: true });
}));

const coupon = z.object({ code: z.string().trim().toUpperCase().min(3).max(20), kind: z.enum(["percent", "flat"]), value: z.number().int().min(1), min_amount: z.number().int().min(0).default(0), first_order_only: z.boolean().default(false), active: z.boolean().default(true), expires_at: z.string().datetime().optional(), usage_limit: z.number().int().min(1).optional(), description: z.string().max(120).optional() });
r.get("/coupons", wrap(async (_q, res) => res.json((await q("SELECT * FROM coupons ORDER BY code")).rows)));
r.post("/coupons", wrap(async (req, res) => {
  const d = parse(coupon, req.body);
  if (d.kind === "percent" && d.value > 90) bad(400, "Percent discount cannot exceed 90");
  await q("INSERT INTO coupons(code,kind,value,min_amount,first_order_only,active,expires_at,usage_limit,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(code) DO UPDATE SET kind=$2,value=$3,min_amount=$4,first_order_only=$5,active=$6,expires_at=$7,usage_limit=$8,description=$9", [d.code, d.kind, d.value, d.min_amount, d.first_order_only, d.active, d.expires_at || null, d.usage_limit || null, d.description || null]);
  await audit(req.user.id, "coupon.save", { code: d.code }); res.status(201).json({ ok: true });
}));
r.delete("/coupons/:code", wrap(async (req, res) => { await q("UPDATE coupons SET active=false WHERE code=$1", [req.params.code.toUpperCase()]); await audit(req.user.id, "coupon.disable", { code: req.params.code }); res.json({ ok: true }); }));

r.get("/banners", wrap(async (_q, res) => res.json((await q("SELECT * FROM banners ORDER BY id DESC")).rows)));
r.post("/banners", wrap(async (req, res) => { const d = parse(z.object({ text: z.string().trim().min(2).max(120), link: z.string().max(200).optional() }), req.body); const { rows } = await q("INSERT INTO banners(text,link) VALUES($1,$2) RETURNING *", [d.text, d.link || null]); await audit(req.user.id, "banner.create", d); res.status(201).json(rows[0]); }));
r.patch("/banners/:id", wrap(async (req, res) => { const d = parse(z.object({ text: z.string().max(120).optional(), active: z.boolean().optional() }), req.body); await q("UPDATE banners SET text=COALESCE($1,text),active=COALESCE($2,active) WHERE id=$3", [d.text, d.active, req.params.id]); await audit(req.user.id, "banner.update", d); res.json({ ok: true }); }));
r.delete("/banners/:id", wrap(async (req, res) => { await q("DELETE FROM banners WHERE id=$1", [req.params.id]); await audit(req.user.id, "banner.delete", { id: req.params.id }); res.json({ ok: true }); }));

r.get("/reports", wrap(async (_q, res) => res.json((await q("SELECT r.id,r.reason,r.resolved,r.created_at,p.id AS product_id,p.title,u.name AS reporter FROM reports r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=r.reporter_id ORDER BY r.resolved,r.created_at DESC LIMIT 200")).rows)));
r.patch("/reports/:id", wrap(async (req, res) => {
  const d = parse(z.object({ resolved: z.boolean().default(true), removeListing: z.boolean().default(false) }), req.body);
  const rep = (await q("UPDATE reports SET resolved=$1 WHERE id=$2 RETURNING product_id", [d.resolved, req.params.id])).rows[0];
  if (!rep) bad(404, "Report not found");
  if (d.removeListing) await q("UPDATE products SET status='removed' WHERE id=$1", [rep.product_id]);
  await audit(req.user.id, "report.resolve", { id: req.params.id, ...d }); res.json({ ok: true });
}));
r.patch("/reviews/:productId/:userId", wrap(async (req, res) => { const d = parse(z.object({ hidden: z.boolean() }), req.body); await q("UPDATE reviews SET hidden=$1 WHERE product_id=$2 AND user_id=$3", [d.hidden, req.params.productId, req.params.userId]); await audit(req.user.id, "review.moderate", { ...req.params, ...d }); res.json({ ok: true }); }));
r.post("/groups", wrap(async (req, res) => {
  const d = parse(z.object({ product_id: z.number().int(), target: z.number().int().min(2).max(1000), group_price: z.number().int().min(1), days: z.number().int().min(1).max(60) }), req.body);
  const p = (await q("SELECT price FROM products WHERE id=$1 AND status='active'", [d.product_id])).rows[0];
  if (!p) bad(404, "Product not found");
  if (d.group_price >= p.price) bad(400, "Group price must be lower than the normal price");
  await q("INSERT INTO group_deals(product_id,target,group_price,ends_at) VALUES($1,$2,$3,now()+make_interval(days=>$4))", [d.product_id, d.target, d.group_price, d.days]);
  await audit(req.user.id, "group.create", d); res.status(201).json({ ok: true });
}));
r.get("/requests", wrap(async (_q, res) => res.json((await q("SELECT r.id,r.text,r.city,r.status,r.created_at,u.name FROM product_requests r JOIN users u ON u.id=r.user_id ORDER BY (r.status='open') DESC,r.created_at DESC LIMIT 100")).rows)));
r.patch("/requests/:id", wrap(async (req, res) => { const d = parse(z.object({ status: z.enum(["open", "fulfilled", "closed"]) }), req.body); await q("UPDATE product_requests SET status=$1 WHERE id=$2", [d.status, req.params.id]); await audit(req.user.id, "request.update", { id: req.params.id, ...d }); res.json({ ok: true }); }));
export default r;
