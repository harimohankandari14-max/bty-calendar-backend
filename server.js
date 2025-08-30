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

// ---------- ENV ----------
const {
  PORT = 3000,
  BASE_URL,                               // e.g. https://bty-calendar-backend.onrender.com (NO trailing slash)
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET = 'change-me',
  DEFAULT_TZ = 'Asia/Kolkata',
  API_KEY,                                 // secret header for GPT Actions / cron calls
  ROUTINES_URL,                            // raw GitHub URL to routines.yaml/.json
  ROUTINES_LOOKAHEAD_DAYS = '14'
} = process.env;

// ---------- APP ----------
const app = express();
app.use(morgan('tiny'));
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE'] }));
app.use(
  session({
    name: 'sess',
    secret: SESSION_SECRET,
    httpOnly: true,
    sameSite: 'lax',
    secure: true
  })
);

// ---------- GOOGLE OAUTH ----------
const oauth2 = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/oauth2callback`
);
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// Single-user token store for server-to-server Action calls
let GLOBAL_TOKENS = null_
