CREATE EXTENSION pg_stat_statements;
CREATE TABLE customers (id serial PRIMARY KEY, email text);
INSERT INTO customers (email) SELECT 'user' || g || '@example.com' FROM generate_series(1, 20000) g;
CREATE TABLE orders (id serial PRIMARY KEY, customer_id int REFERENCES customers(id), status text, created_at timestamptz);
INSERT INTO orders (customer_id, status, created_at)
  SELECT 1 + g % 20000, (ARRAY['new','paid','shipped'])[1 + g % 3], now() - (g || ' minutes')::interval
  FROM generate_series(1, 50000) g;
ANALYZE;
