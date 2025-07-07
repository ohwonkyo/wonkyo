const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { diff } = require('deep-diff');
const XLSX = require('xlsx');
const { google } = require('googleapis');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const path = require('path');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'secret';
const ADMIN_IP_WHITELIST = process.env.ADMIN_IP_WHITELIST
  ? process.env.ADMIN_IP_WHITELIST.split(',')
  : null;

const serviceAccountPath = process.env.FIREBASE_CRED_FILE;
if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath))
  });
} else {
  console.warn('Firebase credentials not found; data will be stored in memory');
}

const db = admin.apps.length ? admin.firestore() : null;
const CERT_DIR = path.join(__dirname, 'certificates');
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR);
const memory = {
  surveys: [],
  users: [{ id: '1', email: 'admin@example.com', role: 'admin', blocked: false, passwordHash: bcrypt.hashSync('admin', 10) }],
  stats: { surveys: 0, responses: 0, apiCalls: 0 },
  config: { googleSheets: null, bigQuery: null, firebase: null },
  versions: {},
  templates: [
    {
      id: '1',
      title: { ko: '만족도 조사' },
      questions: [
        { text: { ko: '서비스 만족도를 1~5로 평가해주세요' } },
        { text: { ko: '개선이 필요한 점이 있다면 적어주세요' } }
      ]
    },
    {
      id: '2',
      title: { ko: '이벤트 신청' },
      questions: [
        { text: { ko: '이름을 입력하세요' } },
        { text: { ko: '이메일 주소를 입력하세요' } },
        { text: { ko: '참석 가능한 날짜를 선택하세요' } }
      ]
    },
    {
      id: '3',
      title: { ko: '시장 조사' },
      questions: [
        { text: { ko: '성별을 선택하세요' } },
        { text: { ko: '연령대를 선택하세요' } },
        { text: { ko: '제품 구매 경험이 있으신가요?' } }
      ]
    }
  ]
};

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const BASE_URL = process.env.BASE_URL || '';
const GSHEET_ID = process.env.GSHEET_ID;
const GSHEET_CRED = process.env.GSHEET_CRED_FILE;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
let mailer = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

let sheets = null;
if (GSHEET_ID && GSHEET_CRED && fs.existsSync(GSHEET_CRED)) {
  const auth = new google.auth.GoogleAuth({
    keyFile: GSHEET_CRED,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheets = google.sheets({ version: 'v4', auth });
}

function sanitize(str) {
  return validator.escape(String(str));
}

function sanitizeLangFields(obj) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      out[k] = sanitize(obj[k]);
    }
  }
  return out;
}

function anonymizeAnswers(answers) {
  const out = {};
  for (const k of Object.keys(answers)) {
    let v = answers[k];
    if (typeof v === 'string' && v.includes('@')) {
      v = require('crypto').createHash('sha256').update(v).digest('hex');
    }
    out[k] = sanitize(v);
  }
  return out;
}

function isClosed(survey) {
  if (survey.closed) return true;
  if (survey.closeDate && new Date() > new Date(survey.closeDate)) return true;
  if (
    survey.responseLimit &&
    (survey.responses?.length || 0) >= survey.responseLimit
  )
    return true;
  return false;
}

async function appendToSheet(values) {
  if (!sheets || !GSHEET_ID) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_ID,
      range: 'Sheet1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] }
    });
  } catch (e) {
    console.error('sheets', e.message);
  }
}

async function sendWebhook(data) {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(WEBHOOK_URL, data, {
      headers: WEBHOOK_TOKEN ? { Authorization: `Bearer ${WEBHOOK_TOKEN}` } : {}
    });
  } catch (e) {
    console.error('webhook', e.message);
  }
}

function generateCertificate(survey, resp) {
  if (!survey.certificate || !survey.certificate.enabled) return null;
  const doc = new PDFDocument();
  const id = `${resp.id || Date.now()}`;
  const file = path.join(CERT_DIR, `${survey.id}-${id}.pdf`);
  doc.fontSize(20).text('Certificate of Participation', { align: 'center' });
  doc.moveDown();
  const name =
    survey.certificate.nameField !== undefined &&
    resp.answers[survey.certificate.nameField] ?
      resp.answers[survey.certificate.nameField] : 'Participant';
  doc.fontSize(14).text(`This certifies that ${name} completed`);
  doc.text(`${survey.title?.ko || survey.title}`);
  doc.text(`Date: ${new Date(resp.submittedAt).toLocaleDateString()}`);
  if (survey.certificate.issuer)
    doc.text(`Issued by: ${survey.certificate.issuer}`);
  doc.pipe(fs.createWriteStream(file));
  doc.end();
  return file;
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(helmet());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(cookieParser());
app.use(csrf({ cookie: true }));
app.use((req, res, next) => {
  res.cookie('XSRF-TOKEN', req.csrfToken());
  next();
});

app.use((req, res, next) => {
  memory.stats.apiCalls++;
  next();
});

function requireAdmin(req, res, next) {
  const token = req.headers['authorization'];
  if (ADMIN_IP_WHITELIST && !ADMIN_IP_WHITELIST.includes(req.ip)) {
    return res.status(403).json({ error: 'ip not allowed' });
  }
  if (!ADMIN_TOKEN || token === `Bearer ${ADMIN_TOKEN}`) return next();
  res.status(401).json({ error: 'admin auth required' });
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^User (.+)$/);
  if (match) {
    const user = memory.users.find(u => u.id === match[1] && !u.blocked);
    if (user) {
      req.user = user;
      return next();
    }
  }
  res.status(401).json({ error: 'auth required' });
}

// ----- Template endpoints -----
app.get('/api/templates', (req, res) => {
  res.json(memory.templates.map(t => ({ id: t.id, title: t.title })));
});

app.get('/api/templates/:id', (req, res) => {
  const t = memory.templates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).end();
  res.json(t);
});

app.get('/api/surveys', async (req, res) => {
  if (db) {
    const snapshot = await db.collection('surveys').get();
    return res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  }
  res.json(memory.surveys);
});

app.post('/api/surveys', async (req, res) => {
  const rawTitle = req.body.title;
  const titleObj =
    typeof rawTitle === 'string'
      ? { ko: sanitize(rawTitle) }
      : sanitizeLangFields(rawTitle || {});
  let questions = (req.body.questions || []).map(q => {
    if (typeof q === 'string') {
      return { text: { ko: sanitize(q) } };
    }
    const obj = { text: sanitizeLangFields(q.text || {}) };
    if (q.type) obj.type = sanitize(q.type);
    if (q.config && typeof q.config === 'object') obj.config = q.config;
    if (Array.isArray(q.options)) {
      obj.options = q.options.map(opt => {
        if (typeof opt === 'string') {
          return { text: { ko: sanitize(opt) } };
        }
        return { text: sanitizeLangFields(opt.text || {}), value: sanitize(opt.value || '') };
      });
    }
    return obj;
  });
  if (!questions.length && req.body.templateId) {
    const tpl = memory.templates.find(t => t.id === req.body.templateId);
    if (tpl) questions = JSON.parse(JSON.stringify(tpl.questions));
  }
  const visibility = ['public', 'private', 'invite'].includes(req.body.visibility) ? req.body.visibility : (req.body.public === false ? 'invite' : 'public');
  const data = {
    title: titleObj,
    questions,
    visibility,
    public: visibility === 'public',
    invites: [],
    allowPartial: req.body.allowPartial !== false,
    allowCollaborators: !!req.body.allowCollaborators,
    duplicateCheck: req.body.duplicateCheck || 'none',
    completionMessage: sanitize(req.body.completionMessage || ''),
    redirectUrl: sanitize(req.body.redirectUrl || ''),
    sendConfirmation: !!req.body.sendConfirmation,
    rewardPoints: Number(req.body.rewardPoints || 0),
    manageRespondents: !!req.body.manageRespondents,
    showRealtime: !!req.body.showRealtime,
    certificate: {
      enabled: !!(req.body.certificate && req.body.certificate.enabled),
      nameField: req.body.certificate ? req.body.certificate.nameField || '' : '',
      issuer: sanitize(req.body.certificate?.issuer || ''),
      logoUrl: sanitize(req.body.certificate?.logoUrl || ''),
      signature: sanitize(req.body.certificate?.signature || '')
    },
    closeDate: sanitize(req.body.closeDate || ''),
    responseLimit: Number(req.body.responseLimit || 0),
    closed: !!req.body.closed
  };
  if (db) {
    const doc = await db.collection('surveys').add(data);
    memory.stats.surveys++;
    return res.json({ id: doc.id });
  }
  const id = String(memory.surveys.length + 1);
  memory.surveys.push({
    id,
    ...data,
    responses: [],
    partials: {},
    emailCodes: {},
    respondedEmails: [],
    respondedUsers: [],
    respondedIps: [],
    collaborators: [],
    certificate: data.certificate,
    closeDate: data.closeDate,
    responseLimit: data.responseLimit,
    closed: data.closed
  });
  memory.versions[id] = [
    {
      version: 1,
      modifier: 'creator',
      timestamp: new Date().toISOString(),
      summary: 'created',
      data: JSON.parse(JSON.stringify(memory.surveys[memory.surveys.length - 1]))
    }
  ];
  memory.stats.surveys++;
  res.json({ id });
});

app.get('/api/surveys/:id', async (req, res) => {
  let survey;
  if (db) {
    const doc = await db.collection('surveys').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).end();
    survey = { id: doc.id, ...doc.data() };
  } else {
    survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
  }
  const visibility = survey.visibility || (survey.public ? 'public' : 'invite');
  if (visibility === 'private') {
    const header = req.headers['authorization'] || '';
    if (!/^User /.test(header)) return res.status(403).json({ error: 'login required' });
  }
  if (visibility === 'invite') {
    const token = req.query.token;
    const valid = survey.invites && survey.invites.find(i => i.token === token);
    if (!valid) return res.status(403).json({ error: 'invite required' });
  }
  if (isClosed(survey)) return res.status(403).json({ error: 'closed' });
  res.json(survey);
});

app.get('/api/surveys/:id/qr', async (req, res) => {
  const token = req.query.token ? `&token=${req.query.token}` : '';
  const link = `${BASE_URL}/client/index.html?id=${req.params.id}${token}`;
  try {
    const qr = await QRCode.toBuffer(link);
    res.type('image/png').send(qr);
  } catch (e) {
    res.status(500).end();
  }
});

app.get('/api/surveys/:id/certificates/:file', (req, res) => {
  const file = path.join(CERT_DIR, req.params.file);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.download(file);
});

app.post('/api/surveys/:id/requestCode', async (req, res) => {
  const email = sanitize(req.body.email || '');
  if (!email) return res.status(400).json({ error: 'email required' });
  const survey = memory.surveys.find(s => s.id === req.params.id);
  if (!survey) return res.status(404).end();
  const code = Math.random().toString(36).slice(2, 8);
  survey.emailCodes[require('crypto').createHash('sha256').update(email).digest('hex')] = code;
  if (mailer) {
    mailer.sendMail({ from: SMTP_USER, to: email, subject: 'Survey Code', text: `Code: ${code}` }).catch(e => console.error('mail', e));
  }
  res.json({ status: 'sent' });
});

app.post('/api/surveys/:id/responses', async (req, res) => {
  const resp = {
    id: Math.random().toString(36).slice(2),
    submittedAt: new Date().toISOString(),
    answers: anonymizeAnswers(req.body.answers || {})
  };
  let survey;
  if (db) {
    const doc = await db.collection('surveys').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).end();
    survey = { id: doc.id, ...doc.data() };
  } else {
    survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
  }

  const token = req.query.token || req.body.token;
  const visibility = survey.visibility || (survey.public ? 'public' : 'invite');
  if (visibility === 'private') {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^User (.+)$/);
    if (!match) return res.status(401).json({ error: 'auth required' });
    resp.userId = match[1];
  }
  if (visibility === 'invite') {
    const valid = survey.invites && survey.invites.find(i => i.token === token);
    if (!valid) return res.status(403).json({ error: 'invite required' });
    if (survey.manageRespondents && token) resp.inviteToken = token;
  }
  if (isClosed(survey)) return res.status(403).json({ error: 'closed' });
  if (survey.manageRespondents && req.body.email && !resp.email) {
    resp.email = sanitize(req.body.email);
  }

  // Duplicate prevention
  const dup = survey.duplicateCheck || 'none';
  if (dup === 'user') {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^User (.+)$/);
    if (!match) return res.status(401).json({ error: 'auth required' });
    resp.userId = match[1];
    if (survey.respondedUsers.includes(resp.userId)) return res.status(403).json({ error: 'duplicate' });
  }
  if (dup === 'cookie') {
    if (req.cookies[`survey_${survey.id}`]) return res.status(403).json({ error: 'duplicate' });
  }
  if (dup === 'ip') {
    if (survey.respondedIps.includes(req.ip)) return res.status(403).json({ error: 'duplicate' });
  }
  if (dup === 'email') {
    const email = sanitize(req.body.email || '');
    const code = req.body.code;
    const key = require('crypto').createHash('sha256').update(email).digest('hex');
    if (!email || !code || survey.emailCodes[key] !== code) return res.status(401).json({ error: 'code required' });
    delete survey.emailCodes[key];
    resp.emailHash = key;
    if (survey.respondedEmails.includes(key)) return res.status(403).json({ error: 'duplicate' });
    if (survey.manageRespondents) resp.email = email;
  }

  if (db) {
    await db.collection('surveys').doc(req.params.id).collection('responses').doc(resp.id).set(resp);
  } else {
    survey.responses = survey.responses || [];
    survey.responses.push(resp);
    if (dup === 'user') survey.respondedUsers.push(resp.userId);
    if (dup === 'ip') survey.respondedIps.push(req.ip);
    if (dup === 'email') survey.respondedEmails.push(resp.emailHash);
  }
  appendToSheet([resp.submittedAt, JSON.stringify(resp.answers)]);
  sendWebhook({ survey: survey.id, response: resp });
  const certPath = generateCertificate(survey, resp);
  if (certPath) resp.certificate = path.basename(certPath);
  memory.stats.responses++;
  if (dup === 'cookie') {
    res.cookie(`survey_${survey.id}`, '1', { maxAge: 365 * 24 * 3600000 });
  }

  let emailAddr = null;
  if (dup === 'email') emailAddr = sanitize(req.body.email || '');
  if (survey.sendConfirmation && !emailAddr && resp.userId) {
    const u = memory.users.find(x => x.id === resp.userId);
    if (u) emailAddr = u.email;
  }
  if (mailer && survey.sendConfirmation && emailAddr) {
    const opts = {
      from: SMTP_USER,
      to: emailAddr,
      subject: 'Survey Response Received',
      text: survey.completionMessage || 'Thank you'
    };
    if (certPath) opts.attachments = [{ filename: 'certificate.pdf', path: certPath }];
    mailer.sendMail(opts).catch(e => console.error('mail', e));
  }
  if (survey.rewardPoints && resp.userId) {
    console.log(`Award ${survey.rewardPoints} points to ${resp.userId}`);
  }

  res.json({ status: 'ok', message: survey.completionMessage, redirect: survey.redirectUrl, certificate: certPath ? `/api/surveys/${survey.id}/certificates/${path.basename(certPath)}` : undefined });
});

app.get('/api/surveys/:id/partial', requireAuth, async (req, res) => {
  let survey;
  if (db) {
    const doc = await db.collection('surveys').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).end();
    survey = { id: doc.id, ...doc.data() };
  } else {
    survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
  }
  if (!survey.allowPartial) return res.json({});
  if (db) {
    const p = await db.collection('surveys').doc(req.params.id).collection('partials').doc(req.user.id).get();
    return res.json(p.exists ? p.data() : {});
  }
  res.json(survey.partials[req.user.id] || {});
});

app.post('/api/surveys/:id/partial', requireAuth, async (req, res) => {
  let survey;
  if (db) {
    const doc = await db.collection('surveys').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).end();
    survey = { id: doc.id, ...doc.data() };
  } else {
    survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
  }
  if (!survey.allowPartial) return res.status(403).end();
  const data = { answers: req.body.answers || {}, updatedAt: new Date().toISOString() };
  if (db) {
    await db.collection('surveys').doc(req.params.id).collection('partials').doc(req.user.id).set(data);
  } else {
    survey.partials[req.user.id] = data;
  }
  res.json({ status: 'saved' });
});

app.get('/api/surveys/:id/stats', async (req, res) => {
  let survey;
  if (db) {
    const doc = await db.collection('surveys').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).end();
    survey = { id: doc.id, ...doc.data() };
  } else {
    survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
  }
  const auth = req.headers['authorization'];
  const isAdmin = auth === `Bearer ${ADMIN_TOKEN}`;
  if (!survey.showRealtime && !isAdmin) return res.status(403).end();
  let list;
  if (db) {
    const snapshot = await db.collection('surveys').doc(req.params.id).collection('responses').get();
    list = snapshot.docs.map(d => d.data());
  } else {
    list = survey.responses || [];
  }
  const stats = { total: list.length, questions: {} };
  list.forEach(r => {
    for (const k of Object.keys(r.answers || {})) {
      const val = r.answers[k];
      stats.questions[k] = stats.questions[k] || {};
      stats.questions[k][val] = (stats.questions[k][val] || 0) + 1;
    }
  });
  res.json(stats);
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = memory.users.find(u => u.email === sanitize(email));
  if (!user || user.blocked) return res.status(401).json({ error: 'invalid' });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'invalid' });
  res.json({ id: user.id, role: user.role });
});

// ---- Admin endpoints ----
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json(memory.stats);
});

app.get('/api/admin/surveys', requireAdmin, async (req, res) => {
  if (db) {
    const snapshot = await db.collection('surveys').get();
    return res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  }
  res.json(memory.surveys);
});

app.delete('/api/admin/surveys/:id', requireAdmin, async (req, res) => {
  if (db) {
    await db.collection('surveys').doc(req.params.id).delete();
    return res.json({ status: 'deleted' });
  }
  const idx = memory.surveys.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).end();
  memory.surveys.splice(idx, 1);
  res.json({ status: 'deleted' });
});

app.put('/api/admin/surveys/:id', requireAdmin, async (req, res) => {
  const data = req.body;
  if (db) {
    await db.collection('surveys').doc(req.params.id).update(data);
    return res.json({ status: 'updated' });
  }
  const survey = memory.surveys.find(s => s.id === req.params.id);
  if (!survey) return res.status(404).end();
  const vlist = memory.versions[req.params.id] || (memory.versions[req.params.id] = []);
  Object.assign(survey, data);
  vlist.push({
    version: vlist.length + 1,
    modifier: 'admin',
    timestamp: new Date().toISOString(),
    summary: Object.keys(data).join(', '),
    data: JSON.parse(JSON.stringify(survey))
  });
  res.json({ status: 'updated' });
});

app.post('/api/admin/surveys/:id/copy', requireAdmin, async (req, res) => {
  if (db) {
    const doc = await db.collection('surveys').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).end();
    const copy = await db.collection('surveys').add(doc.data());
    memory.stats.surveys++;
    return res.json({ id: copy.id });
  }
  const survey = memory.surveys.find(s => s.id === req.params.id);
  if (!survey) return res.status(404).end();
  const id = String(memory.surveys.length + 1);
  const newTitle = {};
  for (const lang of Object.keys(survey.title || {})) {
    newTitle[lang] = `${survey.title[lang]} (copy)`;
  }
  memory.surveys.push({
    id,
    title: newTitle,
    questions: JSON.parse(JSON.stringify(survey.questions)),
    responses: [],
    partials: {},
    emailCodes: {},
    respondedEmails: [],
    respondedUsers: [],
    respondedIps: [],
    visibility: survey.visibility || (survey.public ? 'public' : 'invite'),
    public: (survey.visibility || (survey.public ? 'public' : 'invite')) === 'public',
    invites: [],
    allowPartial: survey.allowPartial,
    duplicateCheck: survey.duplicateCheck,
    completionMessage: survey.completionMessage,
    redirectUrl: survey.redirectUrl,
    sendConfirmation: survey.sendConfirmation,
    rewardPoints: survey.rewardPoints,
    allowCollaborators: survey.allowCollaborators,
    manageRespondents: survey.manageRespondents,
    closeDate: survey.closeDate,
    responseLimit: survey.responseLimit,
    closed: survey.closed
  });
  memory.stats.surveys++;
  res.json({ id });
});

app.post('/api/admin/surveys/:id/template', requireAdmin, async (req, res) => {
  let survey;
  if (db) {
    const doc = await db.collection('surveys').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).end();
    survey = doc.data();
  } else {
    survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
  }
  const tpl = {
    title: survey.title,
    questions: JSON.parse(JSON.stringify(survey.questions || []))
  };
  if (db) {
    const ref = await db.collection('templates').add(tpl);
    return res.json({ id: ref.id });
  }
  const id = String(memory.templates.length + 1);
  memory.templates.push({ id, ...tpl });
  res.json({ id });
});

app.post('/api/admin/surveys/:id/invite', requireAdmin, async (req, res) => {
  const token = require('crypto').randomBytes(16).toString('hex');
  const email = sanitize(req.body.email || '');
  if (db) {
    await db.collection('surveys').doc(req.params.id).collection('invites').doc(token).set({ token, email });
  } else {
    const survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
    survey.invites.push({ token, email });
  }
  if (mailer && email) {
    const url = `${BASE_URL}/client/index.html?id=${req.params.id}&token=${token}`;
    mailer.sendMail({ from: SMTP_USER, to: email, subject: 'Survey Invitation', text: `Please participate: ${url}` }).catch(e => console.error('mail', e));
  }
  res.json({ token });
});

app.get('/api/admin/surveys/:id/responses', requireAdmin, async (req, res) => {
  if (db) {
    const snapshot = await db.collection('surveys').doc(req.params.id).collection('responses').get();
    return res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  }
  const survey = memory.surveys.find(s => s.id === req.params.id);
  if (!survey) return res.status(404).end();
  if (!survey.manageRespondents) return res.status(403).end();
  let list = survey.responses || [];
  const { start, end, contains } = req.query;
  if (start) list = list.filter(r => r.submittedAt >= start);
  if (end) list = list.filter(r => r.submittedAt <= end);
  if (contains) list = list.filter(r => JSON.stringify(r.answers).includes(contains));
  res.json(list);
});

function getResponsesArray(list) {
  const keys = new Set();
  list.forEach(r => Object.keys(r.answers || {}).forEach(k => keys.add(k)));
  const header = ['submittedAt', ...Array.from(keys)];
  const rows = list.map(r => [r.submittedAt, ...Array.from(keys).map(k => r.answers[k] || '')]);
  return { header, rows };
}

app.get('/api/admin/surveys/:id/export/csv', requireAdmin, async (req, res) => {
  let list;
  if (db) {
    const snapshot = await db.collection('surveys').doc(req.params.id).collection('responses').get();
    list = snapshot.docs.map(d => d.data());
  } else {
    const survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
    list = survey.responses || [];
  }
  const { header, rows } = getResponsesArray(list);
  const escape = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [header.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=responses.csv');
  res.send(csv);
});

app.get('/api/admin/surveys/:id/export/xlsx', requireAdmin, async (req, res) => {
  let list;
  if (db) {
    const snapshot = await db.collection('surveys').doc(req.params.id).collection('responses').get();
    list = snapshot.docs.map(d => d.data());
  } else {
    const survey = memory.surveys.find(s => s.id === req.params.id);
    if (!survey) return res.status(404).end();
    list = survey.responses || [];
  }
  const { header, rows } = getResponsesArray(list);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Responses');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=responses.xlsx');
  res.send(buf);
});

app.get('/api/admin/surveys/:id/responses/:rid/certificate', requireAdmin, (req, res) => {
  const file = path.join(CERT_DIR, `${req.params.id}-${req.params.rid}.pdf`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.download(file);
});

app.get('/api/admin/surveys/:id/collaborators', requireAdmin, async (req, res) => {
  const survey = memory.surveys.find(s => s.id === req.params.id);
  if (!survey) return res.status(404).end();
  res.json(survey.collaborators);
});

app.post('/api/admin/surveys/:id/collaborators', requireAdmin, async (req, res) => {
  const survey = memory.surveys.find(s => s.id === req.params.id);
  if (!survey) return res.status(404).end();
  if (!survey.allowCollaborators) return res.status(403).end();
  const id = String((survey.collaborators?.length || 0) + 1);
  const collab = {
    id,
    email: sanitize(req.body.email || ''),
    userId: sanitize(req.body.userId || ''),
    permission: req.body.permission || 'edit'
  };
  survey.collaborators.push(collab);
  res.json({ id });
});

app.delete('/api/admin/surveys/:id/collaborators/:cid', requireAdmin, async (req, res) => {
  const survey = memory.surveys.find(s => s.id === req.params.id);
  if (!survey) return res.status(404).end();
  const idx = survey.collaborators.findIndex(c => c.id === req.params.cid);
  if (idx === -1) return res.status(404).end();
  survey.collaborators.splice(idx, 1);
  res.json({ status: 'deleted' });
});

app.get('/api/admin/surveys/:id/versions', requireAdmin, (req, res) => {
  const list = memory.versions[req.params.id] || [];
  res.json(list.map(v => ({
    version: v.version,
    modifier: v.modifier,
    timestamp: v.timestamp,
    summary: v.summary
  })));
});

app.get('/api/admin/surveys/:id/versions/:vid', requireAdmin, (req, res) => {
  const list = memory.versions[req.params.id] || [];
  const v = list.find(x => String(x.version) === req.params.vid);
  if (!v) return res.status(404).end();
  res.json(v);
});

app.post('/api/admin/surveys/:id/versions/:vid/revert', requireAdmin, (req, res) => {
  const survey = memory.surveys.find(s => s.id === req.params.id);
  if (!survey) return res.status(404).end();
  const list = memory.versions[req.params.id] || [];
  const v = list.find(x => String(x.version) === req.params.vid);
  if (!v) return res.status(404).end();
  const current = JSON.parse(JSON.stringify(survey));
  list.push({
    version: list.length + 1,
    modifier: 'admin',
    timestamp: new Date().toISOString(),
    summary: `revert to ${v.version}`,
    data: current
  });
  Object.keys(survey).forEach(k => delete survey[k]);
  Object.assign(survey, JSON.parse(JSON.stringify(v.data)));
  res.json({ status: 'reverted' });
});

app.get('/api/admin/surveys/:id/versions/:v1/compare/:v2', requireAdmin, (req, res) => {
  const list = memory.versions[req.params.id] || [];
  const a = list.find(x => String(x.version) === req.params.v1);
  const b = list.find(x => String(x.version) === req.params.v2);
  if (!a || !b) return res.status(404).end();
  res.json(diff(a.data, b.data) || []);
});

// ----- Template admin -----
app.get('/api/admin/templates', requireAdmin, (req, res) => {
  res.json(memory.templates);
});

app.post('/api/admin/templates', requireAdmin, (req, res) => {
  const id = String(memory.templates.length + 1);
  const tpl = {
    id,
    title: sanitizeLangFields(req.body.title || {}),
    questions: (req.body.questions || []).map(q => {
      const obj = { text: sanitizeLangFields(q.text || {}) };
      if (q.type) obj.type = sanitize(q.type);
      if (q.config && typeof q.config === 'object') obj.config = q.config;
      if (Array.isArray(q.options)) {
        obj.options = q.options.map(opt => {
          if (typeof opt === 'string') return { text: { ko: sanitize(opt) } };
          return { text: sanitizeLangFields(opt.text || {}), value: sanitize(opt.value || '') };
        });
      }
      return obj;
    })
  };
  memory.templates.push(tpl);
  res.json({ id });
});

app.put('/api/admin/templates/:id', requireAdmin, (req, res) => {
  const tpl = memory.templates.find(t => t.id === req.params.id);
  if (!tpl) return res.status(404).end();
  if (req.body.title) tpl.title = sanitizeLangFields(req.body.title);
  if (req.body.questions) tpl.questions = req.body.questions.map(q => {
    const obj = { text: sanitizeLangFields(q.text || {}) };
    if (q.type) obj.type = sanitize(q.type);
    if (q.config && typeof q.config === 'object') obj.config = q.config;
    if (Array.isArray(q.options)) {
      obj.options = q.options.map(opt => {
        if (typeof opt === 'string') return { text: { ko: sanitize(opt) } };
        return { text: sanitizeLangFields(opt.text || {}), value: sanitize(opt.value || '') };
      });
    }
    return obj;
  });
  res.json({ status: 'updated' });
});

app.delete('/api/admin/templates/:id', requireAdmin, (req, res) => {
  const idx = memory.templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).end();
  memory.templates.splice(idx, 1);
  res.json({ status: 'deleted' });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(memory.users);
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const id = String(memory.users.length + 1);
  const password = req.body.password || 'changeme';
  const user = {
    id,
    email: sanitize(req.body.email),
    role: req.body.role || 'author',
    blocked: false,
    passwordHash: bcrypt.hashSync(password, 10)
  };
  memory.users.push(user);
  const { passwordHash, ...rest } = user;
  res.json(rest);
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = memory.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).end();
  if (req.body.email) user.email = sanitize(req.body.email);
  if (req.body.role) user.role = req.body.role;
  if (req.body.blocked !== undefined) user.blocked = req.body.blocked;
  if (req.body.password) user.passwordHash = bcrypt.hashSync(req.body.password, 10);
  res.json({ status: 'updated' });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json(memory.config);
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  for (const k of Object.keys(req.body)) {
    memory.config[k] = sanitize(req.body[k]);
  }
  res.json({ status: 'updated' });
});

const PORT = process.env.PORT || 5000;
const HTTPS_KEY = process.env.HTTPS_KEY;
const HTTPS_CERT = process.env.HTTPS_CERT;
if (HTTPS_KEY && HTTPS_CERT && fs.existsSync(HTTPS_KEY) && fs.existsSync(HTTPS_CERT)) {
  https.createServer({
    key: fs.readFileSync(HTTPS_KEY),
    cert: fs.readFileSync(HTTPS_CERT)
  }, app).listen(PORT, () => {
    console.log(`HTTPS server running on port ${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
