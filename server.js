// server.js
import 'dotenv/config';
import express from 'express';
import session from 'cookie-session';
import cors from 'cors';
import morgan from 'morgan';
import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import YAML from 'yaml';

// ---------- ENV (single declaration; no duplicate PORT later) ----------
const {
  BASE_URL,                                // https://bty-calendar-backend.onrender.com   (NO trailing slash)
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET = 'change-me',
  DEFAULT_TZ = 'Asia/Kolkata',
  API_KEY,
  ROUTINES_URL,
  ROUTINES_LOOKAHEAD_DAYS = '14'
} = process.env;

// Render provides PORT; fall back for local dev:
const PORT = process.env.PORT || 10000;

// ---------- APP ----------
const app = express();
app.use(morgan('tiny'));
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE'] }));
app.use(session({ name: 'sess', secret: SESSION_SECRET, httpOnly: true, sameSite: 'lax', secure: true }));

// ---------- GOOGLE OAUTH ----------
const oauth2 = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/oauth2callback`
);
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// single-user token store for Actions/cron
let GLOBAL_TOKENS = null;
const getTokens = (req) => GLOBAL_TOKENS || (req.session ? req.session.tokens : null);

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!API_KEY || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized (API key)' });
  next();
}
function requireAuth(req, res, next) {
  if (!getTokens(req)) return res.status(401).json({ error: 'Not authorized. Open /auth to connect Google.' });
  next();
}
function calendarClient(tokens) {
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials(tokens);
  return google.calendar({ version: 'v3', auth });
}

// ---------- ROUTES ----------
app.get('/', (_req, res) => {
  res.type('html').send(`<h2>BTY Calendar Backend</h2><p>Status: OK</p><p><a href="/auth">Connect Google Calendar</a></p>`);
});

app.get('/auth', (req, res) => {
  const state = uuidv4();
  req.session.oauth_state = state;
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');
    if (req.session.oauth_state && state !== req.session.oauth_state) return res.status(400).send('State mismatch');
    const { tokens } = await oauth2.getToken(code);
    req.session.tokens = tokens;
    GLOBAL_TOKENS = tokens;
    res.type('html').send(`<h3>Google Calendar connected ✔</h3><p>You can close this tab.</p>`);
  } catch (e) {
    res.status(500).send('OAuth error: ' + (e?.message || e));
  }
});

// Debug
app.get('/debug/env', (_req, res) => {
  res.json({ hasClientId: !!GOOGLE_CLIENT_ID, hasClientSecret: !!GOOGLE_CLIENT_SECRET, baseUrl: BASE_URL, hasTokens: !!GLOBAL_TOKENS, port: PORT });
});

// ---- Create event (with logs)
app.post('/tool/create_event', requireApiKey, requireAuth, async (req, res) => {
  const body = req.body || {};
  console.log('➡️  create_event', body);
  try {
    const { summary, startISO, endISO, description, location, timezone, attendees } = body;
    if (!summary || !startISO || !endISO) return res.status(400).json({ error: 'summary, startISO, endISO required' });
    const cal = calendarClient(getTokens(req));
    const { data } = await cal.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary, description, location,
        start: { dateTime: startISO, timeZone: timezone || DEFAULT_TZ },
        end:   { dateTime: endISO,   timeZone: timezone || DEFAULT_TZ },
        attendees: (attendees || []).map(e => ({ email: e })),
        reminders: { useDefault: true }
      },
      sendUpdates: 'all'
    });
    console.log('✅ insert ok', { id: data?.id, htmlLink: data?.htmlLink });
    res.json({ id: data?.id, htmlLink: data?.htmlLink, created: true });
  } catch (e) {
    console.error('💥 insert failed', e?.response?.data || e?.message || e);
    res.status(500).json({ error: e?.response?.data || e?.message || 'Unknown error' });
  }
});

// ---- List events (POST)
app.post('/tool/list_events', requireApiKey, requireAuth, async (req, res) => {
  try {
    const { timeMinISO, timeMaxISO, maxResults = 10 } = req.body || {};
    const cal = calendarClient(getTokens(req));
    const { data } = await cal.events.list({
      calendarId: 'primary',
      timeMin: timeMinISO || new Date().toISOString(),
      timeMax: timeMaxISO,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    });
    console.log('📅 list_events', data.items?.length || 0);
    res.json({ items: data.items || [] });
  } catch (e) {
    console.error('💥 list_events failed', e?.response?.data || e?.message || e);
    res.status(500).json({ error: e?.response?.data || e?.message || 'Unknown error' });
  }
});

// ---- Quick test: create small event 5 mins from now
app.post('/tool/test_create', requireApiKey, requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(now.getTime() + 5 * 60 * 1000);
    const end   = new Date(now.getTime() + 15 * 60 * 1000);
    const cal = calendarClient(getTokens(req));
    const { data } = await cal.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: 'BTY TEST (auto)',
        description: 'Sanity check',
        start: { dateTime: start.toISOString(), timeZone: DEFAULT_TZ },
        end:   { dateTime: end.toISOString(),   timeZone: DEFAULT_TZ }
      },
      sendUpdates: 'none'
    });
    console.log('🧪 test_create ok', { id: data?.id });
    res.json({ id: data?.id, htmlLink: data?.htmlLink, start: start.toISOString(), end: end.toISOString() });
  } catch (e) {
    console.error('🧪 test_create failed', e?.response?.data || e?.message || e);
    res.status(500).json({ error: e?.response?.data || e?.message || 'Unknown error' });
  }
});

// ---- Routines sync
app.post('/routines/run', requireApiKey, requireAuth, async (req, res) => {
  try {
    if (!ROUTINES_URL) return res.status(400).json({ error: 'Set ROUTINES_URL env' });
    const txt = await (await fetch(ROUTINES_URL)).text();
    const cfg = ROUTINES_URL.endsWith('.yaml') || ROUTINES_URL.endsWith('.yml') ? YAML.parse(txt) : JSON.parse(txt);
    const items = Array.isArray(cfg) ? cfg : (cfg?.routines || []);

    const cal = calendarClient(getTokens(req));
    const now = new Date();
    const horizon = new Date(now.getTime() + Number(ROUTINES_LOOKAHEAD_DAYS) * 86400000);
    const weekdayMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
    const inHorizon = d => d >= now && d <= horizon;

    const toCreate = [];
    for (const item of items) {
      if (item.days) {
        for (let d = new Date(now); d <= horizon; d = new Date(d.getTime() + 86400000)) {
          if (item.days.map(x=>weekdayMap[x]).includes(d.getDay())) {
            const [sh, sm] = (item.start || '07:00').split(':').map(Number);
            const [eh, em] = (item.end   || '08:00').split(':').map(Number);
            const start = new Date(d); start.setHours(sh, sm ?? 0, 0, 0);
            const end   = new Date(d); end.setHours(eh, em ?? 0, 0, 0);
            if (inHorizon(start)) toCreate.push({ ...item, start, end });
          }
        }
      } else if (item.weekday && (item.time || item.durationMin)) {
        for (let d = new Date(now); d <= horizon; d = new Date(d.getTime() + 86400000)) {
          if (d.getDay() === weekdayMap[item.weekday]) {
            const [h, m] = (item.time || '17:00').split(':').map(Number);
            const start = new Date(d); start.setHours(h, m ?? 0, 0, 0);
            const end = new Date(start.getTime() + (item.durationMin ?? 60) * 60000);
            if (inHorizon(start)) toCreate.push({ ...item, start, end });
          }
        }
      }
    }

    const existing = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: horizon.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500
    });
    const seen = new Set((existing.data.items || []).map(ev => `${ev.summary}|${ev.start?.dateTime}`));

    const results = [];
    for (const ev of toCreate) {
      const startISO = ev.start.toISOString();
      const endISO = ev.end.toISOString();
      const key = `${ev.title}|${startISO}`;
      if (seen.has(key)) continue;
      const { data } = await cal.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: ev.title,
          description: ev.note || '',
          location: ev.location || '',
          start: { dateTime: startISO, timeZone: DEFAULT_TZ },
          end:   { dateTime: endISO,   timeZone: DEFAULT_TZ }
        },
        sendUpdates: 'none'
      });
      results.push({ id: data.id, title: ev.title, start: startISO });
    }

    res.json({ created: results.length, items: results });
  } catch (e) {
    console.error('💥 routines failed', e?.response?.data || e?.message || e);
    res.status(500).json({ error: e?.response?.data || e?.message || 'Unknown error' });
  }
});

// ---------- START ----------
app.listen(PORT, () => console.log(`🚀 BTY backend listening on ${PORT}`));
