import 'dotenv/config';
import express from 'express';
import session from 'cookie-session';
import cors from 'cors';
import morgan from 'morgan';
import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import YAML from 'yaml';
let GLOBAL_TOKENS = null; // <-- holds Google tokens for server-to-server calls
const {
  PORT = 3000,
  BASE_URL, // e.g. https://bty-cal.onrender.com (NO trailing slash)
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET = 'change-me',
  DEFAULT_TZ = 'Asia/Kolkata',
  API_KEY,                 // secret for GPT Actions & cron calls
  ROUTINES_URL,           // raw GitHub URL to your routines.yaml/.json
  ROUTINES_LOOKAHEAD_DAYS = '14'
} = process.env;

const app = express();
app.use(morgan('tiny'));
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE'] }));
app.use(session({ name: 'sess', secret: SESSION_SECRET, httpOnly: true, sameSite: 'lax', secure: true }));

// ---- Google OAuth ----
const oauth2 = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${BASE_URL}/oauth2callback`
);
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

app.get('/', (_req, res) => {
  res.type('html').send(`<h2>BTY Calendar Backend</h2><p>Status: OK</p><a href="/auth">Connect Google Calendar</a>`);
});

app.get('/auth', (req, res) => {
  const state = uuidv4();
  req.session.oauth_state = state;
  const url = oauth2.generateAuthUrl({
    access_type: 'offline', scope: SCOPES, prompt: 'consent', state
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).send('Missing code');
    if (req.session.oauth_state && req.query.state !== req.session.oauth_state) {
      return res.status(400).send('State mismatch');
    }
    const { tokens } = await oauth2.getToken(req.query.code);
    req.session.tokens = tokens; // store securely in DB for multi-user; session is ok for you
    res.type('html').send(`<h3>Google Calendar connected ✔</h3><p>You can close this tab.</p>`);
  } catch (e) { res.status(500).send('OAuth error: ' + e.message); }
});

function calendarClient(tokens) {
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials(tokens);
  return google.calendar({ version: 'v3', auth });
}

function requireAuth(req, res, next) {
  if (!req.session?.tokens) return res.status(401).json({ error: 'Not authorized. Open /auth to connect Google.' });
  next();
}
function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!API_KEY || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized (API key)' });
  next();
}

// ---- GPT Actions endpoints ----
app.post('/tool/create_event', requireApiKey, requireAuth, async (req, res) => {
  try {
    const { summary, startISO, endISO, description, location, timezone, attendees } = req.body;
    if (!summary || !startISO || !endISO) return res.status(400).json({ error: 'summary, startISO, endISO required' });
    const cal = calendarClient(req.session.tokens);
    const { data } = await cal.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary, description, location,
        start: { dateTime: startISO, timeZone: timezone || DEFAULT_TZ },
        end:   { dateTime: endISO,   timeZone: timezone || DEFAULT_TZ },
        attendees: (attendees || []).map(e => ({ email: e })),
        reminders: { useDefault: true }
      }, sendUpdates: 'all'
    });
    res.json({ id: data.id, htmlLink: data.htmlLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/tool/update_event', requireApiKey, requireAuth, async (req, res) => {
  try {
    const { eventId, summary, startISO, endISO, description, location } = req.body;
    if (!eventId) return res.status(400).json({ error: 'eventId required' });
    const cal = calendarClient(req.session.tokens);
    const { data } = await cal.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: {
        summary, description, location,
        start: startISO ? { dateTime: startISO } : undefined,
        end:   endISO   ? { dateTime: endISO }   : undefined
      }, sendUpdates: 'all'
    });
    res.json({ id: data.id, htmlLink: data.htmlLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/tool/delete_event', requireApiKey, requireAuth, async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ error: 'eventId required' });
    const cal = calendarClient(req.session.tokens);
    await cal.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/tool/list_events', requireApiKey, requireAuth, async (req, res) => {
  try {
    const { timeMinISO, timeMaxISO, maxResults = 10 } = req.body;
    const cal = calendarClient(req.session.tokens);
    const { data } = await cal.events.list({
      calendarId: 'primary',
      timeMin: timeMinISO, timeMax: timeMaxISO,
      maxResults, singleEvents: true, orderBy: 'startTime'
    });
    res.json({ items: data.items || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Automation: read GitHub routines, create upcoming events ----
app.post('/routines/run', requireApiKey, requireAuth, async (req, res) => {
  try {
    if (!ROUTINES_URL) return res.status(400).json({ error: 'Set ROUTINES_URL in env' });

    const text = await (await fetch(ROUTINES_URL)).text();
    const config = ROUTINES_URL.endsWith('.yaml') || ROUTINES_URL.endsWith('.yml') ? YAML.parse(text) : JSON.parse(text);

    const cal = calendarClient(req.session.tokens);
    const now = new Date();
    const horizon = new Date(now.getTime() + Number(ROUTINES_LOOKAHEAD_DAYS) * 86400000);

    const weekdayMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
    const inHorizon = (d) => d >= now && d <= horizon;

    const scheduleItems = Array.isArray(config) ? config : (config?.routines || []);
    const toCreate = [];

    for (const item of scheduleItems) {
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

    // skip duplicates (same title+start)
    const existing = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(), timeMax: horizon.toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 2500
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`✅ BTY calendar backend on ${PORT}`));
