CREATE TABLE IF NOT EXISTS users(
 id SERIAL PRIMARY KEY, name TEXT NOT NULL, mobile TEXT UNIQUE NOT NULL, email TEXT,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN('customer','seller','admin')),
 shop_name TEXT, city TEXT,
 seller_status TEXT NOT NULL DEFAULT 'approved' CHECK(seller_status IN('pending','approved','rejected')),
 blocked BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS otps(mobile TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, attempts INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS addresses(
 id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users ON DELETE CASCADE,
 label TEXT NOT NULL DEFAULT 'Home', name TEXT NOT NULL, phone TEXT NOT NULL, line TEXT NOT NULL,
 city TEXT, pin TEXT NOT NULL, is_default BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS categories(id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, icon TEXT);
CREATE TABLE IF NOT EXISTS products(
 id SERIAL PRIMARY KEY, seller_id INT REFERENCES users, category_id INT REFERENCES categories,
 title TEXT NOT NULL, brand TEXT, description TEXT,
 price INT NOT NULL CHECK(price>0), mrp INT NOT NULL CHECK(mrp>0), stock INT NOT NULL DEFAULT 1 CHECK(stock>=0),
 cond TEXT NOT NULL DEFAULT 'New' CHECK(cond IN('New','Used','Refurbished')),
 city TEXT, emoji TEXT DEFAULT '📦', images JSONB NOT NULL DEFAULT '[]', negotiable BOOLEAN NOT NULL DEFAULT false,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','paused','sold','removed')),
 is_demo BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS products_filter ON products(status,category_id,price);
CREATE TABLE IF NOT EXISTS cart_items(user_id INT REFERENCES users ON DELETE CASCADE, product_id INT REFERENCES products ON DELETE CASCADE, qty INT NOT NULL CHECK(qty>0), PRIMARY KEY(user_id,product_id));
CREATE TABLE IF NOT EXISTS wishlist(user_id INT REFERENCES users ON DELETE CASCADE, product_id INT REFERENCES products ON DELETE CASCADE, PRIMARY KEY(user_id,product_id));
CREATE TABLE IF NOT EXISTS coupons(
 code TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('percent','flat')), value INT NOT NULL CHECK(value>0),
 min_amount INT NOT NULL DEFAULT 0, first_order_only BOOLEAN NOT NULL DEFAULT false, active BOOLEAN NOT NULL DEFAULT true,
 expires_at TIMESTAMPTZ, usage_limit INT, used_count INT NOT NULL DEFAULT 0, description TEXT);
CREATE TABLE IF NOT EXISTS orders(
 id TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users,
 status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN('pending','confirmed','processing','shipped','out_for_delivery','delivered','cancelled','returned')),
 subtotal INT NOT NULL, discount INT NOT NULL DEFAULT 0, delivery INT NOT NULL DEFAULT 0, total INT NOT NULL,
 address JSONB NOT NULL, payment_method TEXT NOT NULL CHECK(payment_method IN('cod','razorpay')),
 payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN('pending','paid','failed','refund_pending','refunded')),
 rzp_order_id TEXT, rzp_payment_id TEXT, coupon_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS order_items(id SERIAL PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders ON DELETE CASCADE, product_id INT REFERENCES products, seller_id INT, title TEXT NOT NULL, price INT NOT NULL, qty INT NOT NULL);
CREATE TABLE IF NOT EXISTS returns(order_id TEXT PRIMARY KEY REFERENCES orders, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN('requested','approved','picked_up','refunded','rejected')), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS reviews(product_id INT REFERENCES products ON DELETE CASCADE, user_id INT REFERENCES users ON DELETE CASCADE, stars INT NOT NULL CHECK(stars BETWEEN 1 AND 5), body TEXT NOT NULL, hidden BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(product_id,user_id));
CREATE TABLE IF NOT EXISTS messages(id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES products, buyer_id INT NOT NULL REFERENCES users, sender_id INT NOT NULL REFERENCES users, body TEXT NOT NULL, read BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS messages_thread ON messages(product_id,buyer_id,created_at);
CREATE TABLE IF NOT EXISTS notifications(id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users ON DELETE CASCADE, title TEXT NOT NULL, body TEXT, read BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS reports(id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES products, reporter_id INT NOT NULL REFERENCES users, reason TEXT NOT NULL, resolved BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS banners(id SERIAL PRIMARY KEY, text TEXT NOT NULL, link TEXT, active BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS audit_logs(id SERIAL PRIMARY KEY, admin_id INT REFERENCES users, action TEXT NOT NULL, detail JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO categories(name,icon) VALUES('Grocery','🛒'),('Fruits and Vegetables','🥬'),('Electronics','📺'),('Fashion','👗'),('Clothing','👕'),('Footwear','👟'),('Home and Kitchen','🍳'),('Beauty and Personal Care','💄'),('Mobile Accessories','🔌'),('Stationery','✏️'),('Household Products','🧹'),('Daily Essentials','🧂'),('Mobiles and Tablets','📱'),('Furniture and Decor','🪑'),('Laptops and Computers','💻') ON CONFLICT DO NOTHING;
INSERT INTO coupons(code,kind,value,min_amount,first_order_only,description) VALUES('APNA10','percent',10,500,false,'10% off above ₹500'),('FIRST50','flat',50,199,true,'₹50 off your first order') ON CONFLICT DO NOTHING;

ALTER TABLE users ALTER COLUMN mobile DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES categories;
CREATE TABLE IF NOT EXISTS group_deals(id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES products, target INT NOT NULL CHECK(target>=2), group_price INT NOT NULL CHECK(group_price>0), ends_at TIMESTAMPTZ NOT NULL, reached BOOLEAN NOT NULL DEFAULT false, active BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS group_members(deal_id INT REFERENCES group_deals ON DELETE CASCADE, user_id INT REFERENCES users ON DELETE CASCADE, PRIMARY KEY(deal_id,user_id));
CREATE TABLE IF NOT EXISTS product_requests(id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users, text TEXT NOT NULL, city TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','fulfilled','closed')), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO categories(name,icon,parent_id) SELECT s.n,s.i,c.id FROM categories c JOIN (VALUES ('Mobiles and Tablets','Smartphones','📱'),('Mobiles and Tablets','Tablets','📱'),('Mobiles and Tablets','Feature Phones','☎️'),('Furniture and Decor','Sofas','🛋️'),('Furniture and Decor','Beds','🛏️'),('Furniture and Decor','Tables','🪑'),('Laptops and Computers','Laptops','💻'),('Laptops and Computers','Desktops','🖥️'),('Laptops and Computers','Printers','🖨️')) AS s(p,n,i) ON c.name=s.p ON CONFLICT DO NOTHING;
