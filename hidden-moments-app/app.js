const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Load or initialize data storage
const dataPath = path.join(__dirname, 'data.json');
let data = { users: [], instants: [], fanRanks: [] };
if (fs.existsSync(dataPath)) {
  try {
    const file = fs.readFileSync(dataPath, 'utf-8');
    data = JSON.parse(file);
  } catch (err) {
    console.error('Failed to read data file:', err);
  }
}

function saveData() {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

// Configure Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: 'hidden-moments-secret',
    resave: false,
    saveUninitialized: false
  })
);

// Configure file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage });

// Helpers
function findUserByUsername(username) {
  return data.users.find(u => u.username === username);
}
function findUserById(id) {
  return data.users.find(u => u.id === id);
}
function getCurrentUser(req) {
  return req.session.userId ? findUserById(req.session.userId) : null;
}
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}
function cleanExpiredInstants() {
  const now = Date.now();
  data.instants.forEach(inst => {
    if (!inst.isExpired && inst.expiresAt <= now) {
      inst.isExpired = true;
    }
  });
  // Note: we keep expired instants in data for history and badges
}
// Update fan ranking
function updateFanRank(creatorId, fanId, amount) {
  let rank = data.fanRanks.find(r => r.creatorId === creatorId && r.fanId === fanId);
  if (!rank) {
    rank = { creatorId, fanId, totalCredits: 0 };
    data.fanRanks.push(rank);
  }
  rank.totalCredits += amount;
}

// Expose helper to views
app.locals.findUserById = findUserById;

// Routes
app.get('/', (req, res) => {
  const user = getCurrentUser(req);
  if (user) return res.redirect('/wall');
  res.redirect('/login');
});

app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('register', { error: 'Username and password are required.' });
  }
  if (findUserByUsername(username)) {
    return res.render('register', { error: 'Username already exists.' });
  }
  const newUser = {
    id: uuidv4(),
    username,
    password,
    credits: 20,
    isPremium: false,
    instantsCreated: [],
    instantsPurchased: [],
    badges: []
  };
  data.users.push(newUser);
  saveData();
  req.session.userId = newUser.id;
  res.redirect('/wall');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = findUserByUsername(username);
  if (!user || user.password !== password) {
    return res.render('login', { error: 'Invalid credentials.' });
  }
  req.session.userId = user.id;
  res.redirect('/wall');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/wall', requireLogin, (req, res) => {
  cleanExpiredInstants();
  const user = getCurrentUser(req);
  // Filter non-expired instants
  const activeInstants = data.instants.filter(inst => !inst.isExpired);
  // Sort by expiration ascending
  activeInstants.sort((a, b) => a.expiresAt - b.expiresAt);
  res.render('wall', { user, instants: activeInstants });
});

app.get('/create', requireLogin, (req, res) => {
  res.render('create', { user: getCurrentUser(req), error: null });
});

app.post('/create', requireLogin, upload.single('content'), (req, res) => {
  const { title, exclusive } = req.body;
  const file = req.file;
  if (!title || !file) {
    return res.render('create', { user: getCurrentUser(req), error: 'Title and content are required.' });
  }
  const user = getCurrentUser(req);
  const isExclusive = exclusive === 'on' || exclusive === 'true';
  const price = isExclusive ? 50 : 5;
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  const newInstant = {
    id: uuidv4(),
    title,
    filename: file.filename,
    creatorId: user.id,
    buyers: [],
    isExclusive,
    price,
    createdAt: now,
    expiresAt,
    isExpired: false
  };
  data.instants.push(newInstant);
  user.instantsCreated.push(newInstant.id);
  saveData();
  res.redirect('/wall');
});

app.get('/instant/:id', requireLogin, (req, res) => {
  cleanExpiredInstants();
  const { id } = req.params;
  const instant = data.instants.find(i => i.id === id);
  const user = getCurrentUser(req);
  if (!instant) return res.status(404).send('Instant not found');
  const canViewMedia =
    (instant.creatorId === user.id) ||
    instant.buyers.includes(user.id) ||
    (!instant.isExpired);
  res.render('instant', {
    user,
    instant,
    canViewMedia
  });
});

app.post('/buy/:id', requireLogin, (req, res) => {
  cleanExpiredInstants();
  const { id } = req.params;
  const instant = data.instants.find(i => i.id === id);
  const user = getCurrentUser(req);
  if (!instant || instant.isExpired) {
    return res.redirect('/wall');
  }
  // Prevent buying own instant
  if (instant.creatorId === user.id) {
    return res.redirect('/wall');
  }
  // If exclusive and already bought
  if (instant.isExclusive && instant.buyers.length > 0) {
    return res.redirect('/wall');
  }
  // Already bought
  if (instant.buyers.includes(user.id)) {
    return res.redirect('/wall');
  }
  // Check credits
  if (user.credits < instant.price) {
    return res.redirect('/wallet');
  }
  user.credits -= instant.price;
  user.instantsPurchased.push(instant.id);
  user.badges.push({ instantId: instant.id, exclusive: instant.isExclusive });
  instant.buyers.push(user.id);
  updateFanRank(instant.creatorId, user.id, instant.price);
  saveData();
  res.redirect('/wall');
});

app.get('/profile/:username', requireLogin, (req, res) => {
  const { username } = req.params;
  const profileUser = findUserByUsername(username);
  if (!profileUser) return res.status(404).send('User not found');
  const user = getCurrentUser(req);
  // Top fans for profileUser
  const topFans = data.fanRanks
    .filter(fr => fr.creatorId === profileUser.id)
    .sort((a, b) => b.totalCredits - a.totalCredits)
    .slice(0, 10)
    .map(fr => {
      const fan = findUserById(fr.fanId);
      return { fanUsername: fan.username, credits: fr.totalCredits };
    });
  // Created instants
  const createdInstants = data.instants.filter(inst => inst.creatorId === profileUser.id);
  res.render('profile', { user, profileUser, createdInstants, topFans });
});

app.get('/wallet', requireLogin, (req, res) => {
  const user = getCurrentUser(req);
  res.render('wallet', { user });
});

// Simple check-in to earn credits (once/day)
app.post('/checkin', requireLogin, (req, res) => {
  const user = getCurrentUser(req);
  const now = Date.now();
  if (!user.lastCheckIn || now - user.lastCheckIn >= 24 * 60 * 60 * 1000) {
    user.credits += 3;
    user.lastCheckIn = now;
    saveData();
  }
  res.redirect('/wallet');
});

// Start server
app.listen(PORT, () => {
  console.log(`Hidden Moments app listening on port ${PORT}`);
});