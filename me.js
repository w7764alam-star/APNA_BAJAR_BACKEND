import { Router } from "express";
import { z } from "zod";
import { q, tx } from "./db.js";
import { wrap, parse, bad, auth, notify } from "./lib.js";
const r = Router();
const addr = z.object({ label: z.enum(["Home", "Office", "Other"]).default("Home"), name: z.string().trim().min(2).max(80), phone: z.string().regex(/^[6-9]\d{9}$/), line: z.string().trim().min(5).max(200), city: z.string().trim().max(60).optional(), pin: z.string().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN"), is_default: z.boolean().default(false) });

r.get("/addresses", auth(), wrap(async (req, res) => res.json((await q("SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC,id", [req.user.id])).rows)));
r.post("/addresses", auth(), wrap(async (req, res) => {
  const d = parse(addr, req.body);
  const row = await tx(async c => {
    const first = !(await c.query("SELECT 1 FROM addresses WHERE user_id=$1", [req.user.id])).rowCount;
    if (d.is_default || first) await c.query("UPDATE addresses SET is_default=false WHERE user_id=$1", [req.user.id]);
    return (await c.query("INSERT INTO addresses(user_id,label,name,phone,line,city,pin,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [req.user.id, d.label, d.name, d.phone, d.line, d.city || null, d.pin, d.is_default || first])).rows[0];
  });
  res.status(201).json(row);
}));
r.put("/addresses/:id(\\d+)", auth(), wrap(async (req, res) => {
  const d = parse(addr, req.body);
  const row = await tx(async c => {
    if (d.is_default) await c.query("UPDATE addresses SET is_default=false WHERE user_id=$1", [req.user.id]);
    return (await c.query("UPDATE addresses SET label=$1,name=$2,phone=$3,line=$4,city=$5,pin=$6,is_default=$7 WHERE id=$8 AND user_id=$9 RETURNING *", [d.label, d.name, d.phone, d.line, d.city || null, d.pin, d.is_default, req.params.id, req.user.id])).rows[0];
  });
  if (!row) bad(404, "Address not found");
  res.json(row);
}));
r.delete("/addresses/:id(\\d+)", auth(), wrap(async (req, res) => { await q("DELETE FROM addresses WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]); res.json({ ok: true }); }));

r.get("/notifications", auth(), wrap(async (req, res) => res.json((await q("SELECT id,title,body,read,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [req.user.id])).rows)));
r.post("/notifications/read", auth(), wrap(async (req, res) => { await q("UPDATE notifications SET read=true WHERE user_id=$1", [req.user.id]); res.json({ ok: true }); }));

// Buyer <-> seller messages. A thread is (product, buyer).
r.post("/messages", auth(), wrap(async (req, res) => {
  const d = parse(z.object({ productId: z.number().int(), body: z.string().trim().min(1).max(1000), buyerId: z.number().int().optional() }), req.body);
  const p = (await q("SELECT id,title,seller_id FROM products WHERE id=$1 AND status<>'removed'", [d.productId])).rows[0];
  if (!p || !p.seller_id) bad(404, "This listing has no seller to contact");
  const isSeller = p.seller_id === req.user.id;
  const buyer = isSeller ? d.buyerId : req.user.id;
  if (!buyer) bad(400, "buyerId is required when the seller replies");
  await q("INSERT INTO messages(product_id,buyer_id,sender_id,body) VALUES($1,$2,$3,$4)", [p.id, buyer, req.user.id, d.body]);
  await notify(isSeller ? buyer : p.seller_id, "New message", `About "${p.title}"`);
  res.status(201).json({ ok: true });
}));
r.get("/messages/threads", auth(), wrap(async (req, res) => res.json((await q(`
 SELECT DISTINCT ON (m.product_id,m.buyer_id) m.product_id,m.buyer_id,p.title,m.body AS last_message,m.created_at,
  (SELECT count(*)::int FROM messages x WHERE x.product_id=m.product_id AND x.buyer_id=m.buyer_id AND x.sender_id<>$1 AND NOT x.read) AS unread
 FROM messages m JOIN products p ON p.id=m.product_id
 WHERE m.buyer_id=$1 OR p.seller_id=$1 ORDER BY m.product_id,m.buyer_id,m.created_at DESC`, [req.user.id])).rows)));
r.get("/messages", auth(), wrap(async (req, res) => {
  const d = parse(z.object({ productId: z.coerce.number().int(), buyerId: z.coerce.number().int() }), req.query);
  const p = (await q("SELECT seller_id FROM products WHERE id=$1", [d.productId])).rows[0];
  if (!p || (req.user.id !== d.buyerId && req.user.id !== p.seller_id)) bad(403, "Not allowed");
  await q("UPDATE messages SET read=true WHERE product_id=$1 AND buyer_id=$2 AND sender_id<>$3", [d.productId, d.buyerId, req.user.id]);
  res.json((await q("SELECT id,sender_id,body,created_at FROM messages WHERE product_id=$1 AND buyer_id=$2 ORDER BY created_at", [d.productId, d.buyerId])).rows);
}));
export default r;
