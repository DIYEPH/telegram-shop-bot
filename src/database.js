const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/shop.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();
  
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      account_data TEXT NOT NULL,
      is_sold INTEGER DEFAULT 0,
      buyer_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      stock_id INTEGER,
      status TEXT DEFAULT 'pending',
      chat_id INTEGER,
      content TEXT,
      quantity INTEGER DEFAULT 1,
      total_price INTEGER,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  saveDB();
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getAllProducts() {
  const result = db.exec(`
    SELECT p.id, p.name, p.price, p.description, 
           COUNT(CASE WHEN s.is_sold = 0 THEN 1 END) as stock_count
    FROM products p
    LEFT JOIN stock s ON p.id = s.product_id
    GROUP BY p.id
  `);
  if (!result.length) return [];
  return result[0].values.map(row => ({
    id: row[0], name: row[1], price: row[2], description: row[3], stock_count: row[4]
  }));
}

function getProduct(id) {
  const result = db.exec(`
    SELECT p.id, p.name, p.price, p.description,
           COUNT(CASE WHEN s.is_sold = 0 THEN 1 END) as stock_count
    FROM products p
    LEFT JOIN stock s ON p.id = s.product_id
    WHERE p.id = ${id}
    GROUP BY p.id
  `);
  if (!result.length || !result[0].values.length) return null;
  const row = result[0].values[0];
  return { id: row[0], name: row[1], price: row[2], description: row[3], stock_count: row[4] };
}

function addProduct(name, price, description = '') {
  db.run(`INSERT INTO products (name, price, description) VALUES (?, ?, ?)`, [name, price, description]);
  const result = db.exec('SELECT last_insert_rowid()');
  saveDB();
  return { lastInsertRowid: result[0].values[0][0] };
}

function deleteProduct(id) {
  db.run(`DELETE FROM stock WHERE product_id = ?`, [id]);
  db.run(`DELETE FROM products WHERE id = ?`, [id]);
  saveDB();
}

function addStock(productId, accountData) {
  db.run(`INSERT INTO stock (product_id, account_data) VALUES (?, ?)`, [productId, accountData]);
  saveDB();
}

function deleteStock(stockId) {
  db.run(`DELETE FROM stock WHERE id = ? AND is_sold = 0`, [stockId]);
  saveDB();
}

function clearStock(productId) {
  db.run(`DELETE FROM stock WHERE product_id = ? AND is_sold = 0`, [productId]);
  saveDB();
}

function getAvailableStock(productId) {
  const result = db.exec(`SELECT id, product_id, account_data FROM stock WHERE product_id = ${productId} AND is_sold = 0 LIMIT 1`);
  if (!result.length || !result[0].values.length) return null;
  const row = result[0].values[0];
  return { id: row[0], product_id: row[1], account_data: row[2] };
}

function markStockSold(stockId, buyerId) {
  db.run(`UPDATE stock SET is_sold = 1, buyer_id = ? WHERE id = ?`, [buyerId, stockId]);
  saveDB();
}

function createOrder(userId, productId, chatId, content, quantity, totalPrice) {
  const createdAt = Date.now();
  db.run(`INSERT INTO orders (user_id, product_id, chat_id, content, quantity, total_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
    [userId, productId, chatId, content, quantity, totalPrice, createdAt]);
  const result = db.exec('SELECT last_insert_rowid()');
  saveDB();
  return { lastInsertRowid: result[0].values[0][0], createdAt };
}

function updateOrder(orderId, stockId, status) {
  db.run(`UPDATE orders SET stock_id = ?, status = ? WHERE id = ?`, [stockId, status, orderId]);
  saveDB();
}

function getPendingOrders() {
  const result = db.exec(`
    SELECT id, user_id, product_id, chat_id, content, quantity, total_price, created_at 
    FROM orders 
    WHERE status = 'pending' AND content IS NOT NULL
  `);
  if (!result.length) return [];
  return result[0].values.map(row => ({
    id: row[0],
    userId: row[1],
    productId: row[2],
    chatId: row[3],
    content: row[4],
    quantity: row[5],
    totalPrice: row[6],
    createdAt: row[7]
  }));
}

function getOrdersByUser(userId) {
  const result = db.exec(`
    SELECT o.id, o.status, p.name as product_name, p.price
    FROM orders o
    JOIN products p ON o.product_id = p.id
    WHERE o.user_id = ${userId}
    ORDER BY o.id DESC
  `);
  if (!result.length) return [];
  return result[0].values.map(row => ({
    id: row[0], status: row[1], product_name: row[2], price: row[3]
  }));
}

module.exports = {
  initDB, getAllProducts, getProduct, addProduct, deleteProduct,
  addStock, deleteStock, clearStock, getAvailableStock, markStockSold, createOrder, updateOrder, getOrdersByUser, getPendingOrders,
  saveUser: (id, firstName, username) => {
    db.run(`INSERT OR REPLACE INTO users (id, first_name, username) VALUES (?, ?, ?)`, [id, firstName, username]);
    saveDB();
  },
  getAllUsers: () => {
    const result = db.exec('SELECT id, first_name, username FROM users');
    if (!result.length) return [];
    return result[0].values.map(row => ({ id: row[0], first_name: row[1], username: row[2] }));
  },
  
  // Sửa sản phẩm
  updateProduct: (id, name, price, description) => {
    db.run(`UPDATE products SET name = ?, price = ?, description = ? WHERE id = ?`, [name, price, description, id]);
    saveDB();
  },
  
  // Xem stock của sản phẩm
  getStockByProduct: (productId) => {
    const result = db.exec(`SELECT id, account_data, is_sold, buyer_id FROM stock WHERE product_id = ${productId}`);
    if (!result.length) return [];
    return result[0].values.map(row => ({ id: row[0], account_data: row[1], is_sold: row[2], buyer_id: row[3] }));
  },
  
  // Lịch sử mua hàng chi tiết
  getOrderHistory: (userId) => {
    const result = db.exec(`
      SELECT o.id, o.status, p.name, p.price, s.account_data
      FROM orders o
      JOIN products p ON o.product_id = p.id
      LEFT JOIN stock s ON o.stock_id = s.id
      WHERE o.user_id = ${userId}
      ORDER BY o.id DESC
      LIMIT 20
    `);
    if (!result.length) return [];
    return result[0].values.map(row => ({ 
      id: row[0], status: row[1], product_name: row[2], price: row[3], account_data: row[4] 
    }));
  },
  
  // Thống kê doanh thu
  getRevenue: () => {
    const today = new Date().toISOString().split('T')[0];
    const result = db.exec(`
      SELECT 
        COUNT(CASE WHEN o.status = 'completed' THEN 1 END) as total_orders,
        SUM(CASE WHEN o.status = 'completed' THEN p.price ELSE 0 END) as total_revenue
      FROM orders o
      JOIN products p ON o.product_id = p.id
    `);
    if (!result.length || !result[0].values.length) return { total_orders: 0, total_revenue: 0 };
    return { total_orders: result[0].values[0][0] || 0, total_revenue: result[0].values[0][1] || 0 };
  },
  
  // Danh sách đơn hàng gần đây (admin)
  getRecentOrders: (limit = 20) => {
    const result = db.exec(`
      SELECT o.id, o.user_id, o.status, p.name, p.price, u.first_name
      FROM orders o
      JOIN products p ON o.product_id = p.id
      LEFT JOIN users u ON o.user_id = u.id
      ORDER BY o.id DESC
      LIMIT ${limit}
    `);
    if (!result.length) return [];
    return result[0].values.map(row => ({ 
      id: row[0], user_id: row[1], status: row[2], product_name: row[3], price: row[4], user_name: row[5] || 'Unknown'
    }));
  }
};
