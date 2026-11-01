import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { q, tx } from "./db.js";
import { wrap, parse, bad, auth, notify, price, groupPrices } from "./lib.js";
const r = Router();
const rzpReady = () => process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET;
const newId = () => "AB" + Date.now().toString().slice(-7) + crypto.randomInt(10, 99);

r.post("/checkout", auth(), wrap(async (req, res) => {
  const b = parse(z.object({ addressId: z.number().int(), payment_method: z.enum(["cod", "razorpay"]), coupon: z.string().max(30).optional() }), req.body);
  if (b.payment_method === "razorpay" && !rzpReady()) bad(503, "Online payment is not configured. Use Cash on Delivery");
  const out = await tx(async c => {
    const addr = (await c.query("SELECT label,name,phone,line,city,pin FROM addresses WHERE id=$1 AND user_id=$2", [b.addressId, req.user.id])).rows[0];
    if (!addr) bad(400, "Select a delivery address");
    const lines = (await c.query("SELECT ci.product_id,ci.qty,p.title,p.price,p.stock,p.status,p.seller_id FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.user_id=$1 ORDER BY p.id FOR UPDATE OF p", [req.user.id])).rows;
    if (!lines.length) bad(400, "Your cart is empty");
    for (const l of lines) {
      if (l.status !== "active" || l.stock < l.qty) bad(409, `"${l.title}" is no longer available in that quantity`);
      if (l.seller_id === req.user.id) bad(400, "You cannot buy your own listing");
    }
    await groupPrices(c, req.user.id, lines);
    const t = await price(req.user.id, lines, b.coupon, c);
    const id = newId();
    await c.query("INSERT INTO orders(id,user_id,status,subtotal,discount,delivery,total,address,payment_method,coupon_code) VALUES($1,$2,'confirmed',$3,$4,$5,$6,$7,$8,$9)", [id, req.user.id, t.subtotal, t.discount, t.delivery, t.total, addr, b.payment_method, t.coupon]);
    for (const l of lines) {
      await c.query("INSERT INTO order_items(order_id,product_id,seller_id,title,price,qty) VALUES($1,$2,$3,$4,$5,$6)", [id, l.product_id, l.seller_id, l.title, l.price, l.qty]);
      await c.query("UPDATE products SET stock=stock-$1, status=CASE WHEN stock-$1=0 AND seller_id IS NOT NULL THEN 'sold' ELSE status END WHERE id=$2", [l.qty, l.product_id]);
      if (l.seller_id) await notify(l.seller_id, "New order", `Order #${id} includes "${l.title}"`, c);
    }
    if (t.coupon) await c.query("UPDATE coupons SET used_count=used_count+1 WHERE code=$1", [t.coupon]);
    await c.query("DELETE FROM cart_items WHERE user_id=$1", [req.user.id]);
    await notify(req.user.id, "Order placed", `Order #${id} is confirmed. Total ₹${t.total}`, c);
    let razorpay = null;
    if (b.payment_method === "razorpay") {
      const resp = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64") },
        body: JSON.stringify({ amount: t.total * 100, currency: "INR", receipt: id }),
      });
      if (!resp.ok) bad(502, "Payment gateway error. Please try again");
      const o = await resp.json();
      await c.query("UPDATE orders SET rzp_order_id=$1 WHERE id=$2", [o.id, id]);
      razorpay = { keyId: process.env.RAZORPAY_KEY_ID, orderId: o.id, amount: o.amount };
    }
    return { orderId: id, total: t.total, payment_status: "pending", razorpay };
  });
  res.status(201).json(out);
}));

// Payment is marked paid ONLY after the gateway signature is verified on the server.
r.post("/payments/razorpay/verify", auth(), wrap(async (req, res) => {
  if (!rzpReady()) bad(503, "Online payment is not configured");
  const d = parse(z.object({ orderId: z.string(), razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }), req.body);
  const o = (await q("SELECT id,rzp_order_id FROM orders WHERE id=$1 AND user_id=$2", [d.orderId, req.user.id])).rows[0];
  if (!o || o.rzp_order_id !== d.razorpay_order_id) bad(400, "Order mismatch");
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${d.razorpay_order_id}|${d.razorpay_payment_id}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(d.razorpay_signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { await q("UPDATE orders SET payment_status='failed' WHERE id=$1 AND payment_status='pending'", [o.id]); bad(400, "Payment verification failed"); }
  await q("UPDATE orders SET payment_status='paid',rzp_payment_id=$1,updated_at=now() WHERE id=$2", [d.razorpay_payment_id, o.id]);
  await notify(req.user.id, "Payment received", `Payment for order #${o.id} was successful`);
  res.json({ ok: true });
}));

// Retry payment for an online order that is still unpaid
r.post("/orders/:id/pay", auth(), wrap(async (req, res) => {
  if (!rzpReady()) bad(503, "Online payment is not configured");
  const o = (await q("SELECT id,total,payment_method,payment_status,status FROM orders WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id])).rows[0];
  if (!o) bad(404, "Order not found");
  if (o.payment_method !== "razorpay" || !["pending", "failed"].includes(o.payment_status) || o.status === "cancelled") bad(400, "This order cannot be paid online");
  const resp = await fetch("https://api.razorpay.com/v1/orders", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64") }, body: JSON.stringify({ amount: o.total * 100, currency: "INR", receipt: o.id + "-" + Date.now().toString().slice(-4) }) });
  if (!resp.ok) bad(502, "Payment gateway error. Please try again");
  const g = await resp.json();
  await q("UPDATE orders SET rzp_order_id=$1,payment_status='pending' WHERE id=$2", [g.id, o.id]);
  res.json({ orderId: o.id, razorpay: { keyId: process.env.RAZORPAY_KEY_ID, orderId: g.id, amount: g.amount } });
}));
const withItems = async (orders) => {
  if (!orders.length) return orders;
  const items = (await q("SELECT order_id,product_id,title,price,qty FROM order_items WHERE order_id=ANY($1)", [orders.map(o => o.id)])).rows;
  return orders.map(o => ({ ...o, items: items.filter(i => i.order_id === o.id) }));
};
r.get("/orders", auth(), wrap(async (req, res) => res.json(await withItems((await q("SELECT o.*,r.status AS return_status FROM orders o LEFT JOIN returns r ON r.order_id=o.id WHERE o.user_id=$1 ORDER BY o.created_at DESC LIMIT 100", [req.user.id])).rows))));
r.get("/orders/:id", auth(), wrap(async (req, res) => {
  const o = (await q("SELECT o.*,r.status AS return_status,r.reason AS return_reason FROM orders o LEFT JOIN returns r ON r.order_id=o.id WHERE o.id=$1 AND o.user_id=$2", [req.params.id, req.user.id])).rows[0];
  if (!o) bad(404, "Order not found");
  res.json((await withItems([o]))[0]);
}));
r.post("/orders/:id/cancel", auth(), wrap(async (req, res) => {
  await tx(async c => {
    const o = (await c.query("SELECT * FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE", [req.params.id, req.user.id])).rows[0];
    if (!o) bad(404, "Order not found");
    if (!["confirmed", "processing"].includes(o.status)) bad(400, "This order can no longer be cancelled");
    const items = (await c.query("SELECT product_id,qty FROM order_items WHERE order_id=$1", [o.id])).rows;
    for (const i of items) await c.query("UPDATE products SET stock=stock+$1, status=CASE WHEN status='sold' THEN 'active' ELSE status END WHERE id=$2", [i.qty, i.product_id]);
    await c.query("UPDATE orders SET status='cancelled',payment_status=CASE WHEN payment_status='paid' THEN 'refund_pending' ELSE payment_status END,updated_at=now() WHERE id=$1", [o.id]);
    await notify(req.user.id, "Order cancelled", `Order #${o.id} was cancelled`, c);
  });
  res.json({ ok: true });
}));
r.post("/orders/:id/return", auth(), wrap(async (req, res) => {
  const d = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  const o = (await q("SELECT status,updated_at FROM orders WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id])).rows[0];
  if (!o) bad(404, "Order not found");
  if (o.status !== "delivered") bad(400, "Only delivered orders can be returned");
  if (Date.now() - new Date(o.updated_at).getTime() > 7 * 864e5) bad(400, "The 7-day return window has closed");
  try { await q("INSERT INTO returns(order_id,reason) VALUES($1,$2)", [req.params.id, d.reason]); } catch (e) { if (e.code === "23505") bad(409, "Return already requested"); throw e; }
  await notify(req.user.id, "Return requested", `Return for order #${req.params.id} is requested`);
  res.status(201).json({ ok: true });
}));
export default r;
