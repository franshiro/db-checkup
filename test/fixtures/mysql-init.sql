-- orders.customer_id deliberately has no FOREIGN KEY: InnoDB would create an index for it and the full-scan scenario would vanish.
-- A scratch table is doubled with INSERT ... SELECT (recursive CTEs stop at 1000 by default); the tables take exactly the first N rows of it.
CREATE TABLE seed (id INT AUTO_INCREMENT PRIMARY KEY);
INSERT INTO seed VALUES (NULL);
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
INSERT INTO seed SELECT NULL FROM seed;
CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100));
INSERT INTO customers (email) SELECT CONCAT('user', id, '@example.com') FROM seed LIMIT 20000;
CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT, status VARCHAR(10), created_at DATETIME);
INSERT INTO orders (customer_id, status, created_at) SELECT 1 + id % 20000, ELT(1 + id % 3, 'new', 'paid', 'shipped'), NOW() - INTERVAL id MINUTE FROM seed LIMIT 50000;
DROP TABLE seed;
ANALYZE TABLE customers, orders;
