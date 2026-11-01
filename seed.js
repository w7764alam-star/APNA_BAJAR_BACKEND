import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool, q } from "./db.js";
// 1) First admin account from environment variables (never from frontend code)
const { ADMIN_NAME = "Owner", ADMIN_MOBILE, ADMIN_PASSWORD } = process.env;
if (ADMIN_MOBILE && ADMIN_PASSWORD) {
  if (ADMIN_PASSWORD.length < 10) { console.error("ADMIN_PASSWORD must be at least 10 characters"); process.exit(1); }
  await q("INSERT INTO users(name,mobile,password_hash,role) VALUES($1,$2,$3,'admin') ON CONFLICT(mobile) DO UPDATE SET role='admin'", [ADMIN_NAME, ADMIN_MOBILE, await bcrypt.hash(ADMIN_PASSWORD, 12)]);
  console.log("Admin account ready for", ADMIN_MOBILE);
} else console.log("Skipped admin: set ADMIN_MOBILE and ADMIN_PASSWORD in .env");
// 2) DEMO products, clearly flagged is_demo=true. Delete them before going live:
//    DELETE FROM products WHERE is_demo;
const demo = [
 ["Basmati Rice 5 kg","India Gate","Grocery",449,620,40,"🍚"],["Fresh Apples 1 kg","Farm Fresh","Fruits and Vegetables",159,199,60,"🍎"],
 ["Wireless Earbuds","SoundGo","Electronics",1299,2999,25,"🎧"],["Smart Watch","TickFit","Electronics",1999,4499,12,"⌚"],
 ["Cotton T-Shirt","UrbanWear","Clothing",349,799,80,"👕"],["Running Shoes","StrideX","Footwear",1199,2499,30,"👟"],
 ["Pressure Cooker 5 L","HomeChef","Home and Kitchen",1099,1699,22,"🍲"],["Face Wash 100 ml","GlowCare","Beauty and Personal Care",149,225,90,"🧴"],
 ["Fast Charger 33W","VoltEdge","Mobile Accessories",499,999,50,"🔌"],["Notebook Pack of 6","PaperPlus","Stationery",240,330,100,"📓"],
 ["Floor Cleaner 1 L","SparkleHome","Household Products",189,240,70,"🧽"],["Mustard Oil 1 L","Kachi Ghani","Daily Essentials",165,190,55,"🫙"],
];
if (!(await q("SELECT 1 FROM products WHERE is_demo LIMIT 1")).rowCount) {
  for (const [t, b, c, p, m, s, e] of demo)
    await q("INSERT INTO products(title,brand,category_id,price,mrp,stock,emoji,city,is_demo,description) VALUES($1,$2,(SELECT id FROM categories WHERE name=$3),$4,$5,$6,$7,'Siwan',true,'Demo listing for testing only.')", [t, b, c, p, m, s, e]);
  console.log("Demo products added (is_demo=true).");
}
await pool.end();
