import { Router } from "express";
import { z } from "zod";
import { q, tx } from "./db.js";
import { wrap, parse, bad, auth, role, notify } from "./lib.js";
const r = Router();

// ----- Local shops and deals (real data from the database, nothing invented) -----
r.get("/local-deals", wrap(async (req, res) => {
  const city = String(req.query.city || "").slice(0, 60);
  if (!city) return res.json([]);
  res.json((await q("SELECT p.id,p.title,p.price,p.mrp,p.emoji,p.images,p.city,u.shop_name FROM products p LEFT JOIN users u ON u.id=p.seller_id WHERE p.status='active' AND p.stock>0 AND lower(p.city)=lower($1) AND p.mrp>p.price AND (p.mrp-p.price)*100>=15*p.mrp ORDER BY (p.mrp-p.price)::float/p.mrp DESC LIMIT 12", [city])).rows);
}));
r.get("/shops", wrap(async (req, res) => {
  const city = String(req.query.city || "").slice(0, 60);
  res.json((await q("SELECT u.id,u.shop_name,u.city,u.verified,count(p.id)::int AS products FROM users u JOIN products p ON p.seller_id=u.id AND p.status='active' WHERE u.role='seller' AND u.seller_status='approved' AND ($1='' OR lower(u.city)=lower($1)) GROUP BY u.id ORDER BY products DESC LIMIT 20", [city])).rows);
}));
r.get("/sellers/:id(\\d+)", wrap(async (req, res) => {
  const s = (await q("SELECT id,shop_name,city,verified,created_at FROM users WHERE id=$1 AND role='seller' AND seller_status='approved'", [req.params.id])).rows[0];
  if (!s) bad(404, "Seller not found");
  const rt = (await q("SELECT round(avg(rv.stars),1) AS rating,count(rv.*)::int AS reviews FROM reviews rv JOIN products p ON p.id=rv.product_id WHERE p.seller_id=$1 AND NOT rv.hidden", [s.id])).rows[0];
  const pc = (await q("SELECT count(*) FILTER(WHERE status='active')::int active,count(*) FILTER(WHERE status='sold')::int sold FROM products WHERE seller_id=$1", [s.id])).rows[0];
  res.json({ ...s, ...rt, ...pc });
}));
export default r;
