// Profiles and interview sessions, stored in SQLite (sql.js — the SQLite engine
// compiled to WebAssembly, so nothing native to build on any platform).
//
//   profiles     one per company / role: resume, job description, custom prompt,
//                answer style, language. The active profile's fields are merged
//                into the settings the renderer sees (main.js).
//   sessions     one per interview round, belongs to a profile. A later round
//                (e.g. the technical interview after the intro) can reopen an
//                earlier session and continue the same AI conversation.
//   turns        the questions and answers of a session, in order. `prompt` is
//                the exact user message that was sent, so the conversation can
//                be replayed to the model when the session is continued.
//   attachments  screenshots / files of a turn. Binary data lives as files under
//                userData/attachments (keeps the DB small); text stays inline.
//   transcript   every final utterance of both sides, for the PDF report.
//
// sql.js keeps the database in memory; every change schedules a write of the
// whole file (it is only text, so small) to userData/copilot.sqlite.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const PROFILE_FIELDS = ['name', 'resume', 'jobDescription', 'customPrompt', 'answerStyle', 'language'];
const COLUMN = { name: 'name', resume: 'resume', jobDescription: 'job_description', customPrompt: 'custom_prompt', answerStyle: 'answer_style', language: 'language' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, resume TEXT DEFAULT '', job_description TEXT DEFAULT '',
  custom_prompt TEXT DEFAULT '', answer_style TEXT DEFAULT 'detailed', language TEXT DEFAULT 'en',
  created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, last_active INTEGER);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER, question TEXT, prompt TEXT, answer TEXT, error TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  kind TEXT, name TEXT, mime TEXT, file TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS transcript (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel TEXT, text TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id, last_active);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript(session_id, at);
`;

let db = null;
let dbPath = '';
let attachDir = '';
let saveTimer = null;
let dirty = false;

const now = () => Date.now();

// ---- persistence -----------------------------------------------------------

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!db || !dirty) return;
  const bytes = Buffer.from(db.export());
  const tmp = `${dbPath}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dbPath);
  dirty = false;
}

function touch() {
  dirty = true;
  if (!saveTimer) saveTimer = setTimeout(() => { try { flush(); } catch { /* retried on next change / quit */ } }, 800);
}

async function open(userData = app.getPath('userData')) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  dbPath = path.join(userData, 'copilot.sqlite');
  attachDir = path.join(userData, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  let bytes = null;
  try { bytes = fs.readFileSync(dbPath); } catch { /* first run */ }
  db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);
  return module.exports;
}

function close() {
  try { flush(); } catch { /* best effort */ }
  db?.close();
  db = null;
}

// ---- small query helpers ------------------------------------------------------

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
const one = (sql, params) => all(sql, params)[0] || null;
function run(sql, params = []) {
  db.run(sql, params);
  touch();
}
const lastId = () => one('SELECT last_insert_rowid() AS id').id;

// ---- profiles ---------------------------------------------------------------------

const rowToProfile = (r) =>
  r && { id: r.id, name: r.name, resume: r.resume, jobDescription: r.job_description, customPrompt: r.custom_prompt,
    answerStyle: r.answer_style, language: r.language, createdAt: r.created_at, updatedAt: r.updated_at };

function listProfiles() {
  return all('SELECT * FROM profiles ORDER BY name COLLATE NOCASE').map(rowToProfile);
}
function getProfile(id) {
  return rowToProfile(one('SELECT * FROM profiles WHERE id = ?', [id]));
}
function createProfile(fields = {}) {
  const t = now();
  run(
    'INSERT INTO profiles (name, resume, job_description, custom_prompt, answer_style, language, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [fields.name || 'New profile', fields.resume || '', fields.jobDescription || '', fields.customPrompt || '',
      fields.answerStyle || 'detailed', fields.language || 'en', t, t]
  );
  return getProfile(lastId());
}
/** Only PROFILE_FIELDS keys are applied; returns the updated profile. */
function updateProfile(id, patch) {
  const sets = [];
  const params = [];
  for (const k of PROFILE_FIELDS) {
    if (patch[k] === undefined) continue;
    sets.push(`${COLUMN[k]} = ?`);
    params.push(String(patch[k] ?? ''));
  }
  if (!sets.length) return getProfile(id);
  run(`UPDATE profiles SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, now(), id]);
  return getProfile(id);
}
function deleteProfile(id) {
  for (const s of listSessions(id)) deleteSession(s.id);
  run('DELETE FROM profiles WHERE id = ?', [id]);
}

// ---- sessions -----------------------------------------------------------------

function listSessions(profileId) {
  return all(
    `SELECT s.*, (SELECT count(*) FROM turns t WHERE t.session_id = s.id) AS turn_count,
            (SELECT question FROM turns t WHERE t.session_id = s.id ORDER BY seq LIMIT 1) AS first_question
       FROM sessions s WHERE s.profile_id = ? ORDER BY s.last_active DESC, s.id DESC`,
    [profileId]
  ).map((r) => ({ id: r.id, profileId: r.profile_id, title: r.title, startedAt: r.started_at, endedAt: r.ended_at,
    lastActive: r.last_active, turnCount: r.turn_count, firstQuestion: r.first_question || '' }));
}
function createSession(profileId, title) {
  const t = now();
  run('INSERT INTO sessions (profile_id, title, started_at, last_active) VALUES (?,?,?,?)', [profileId, title, t, t]);
  const id = lastId();
  return { id, profileId, title, startedAt: t, endedAt: null, lastActive: t, turnCount: 0, firstQuestion: '' };
}
function renameSession(id, title) {
  run('UPDATE sessions SET title = ? WHERE id = ?', [title, id]);
}
function endSession(id) {
  run('UPDATE sessions SET ended_at = ? WHERE id = ?', [now(), id]);
}
function deleteSession(id) {
  for (const a of all('SELECT file FROM attachments WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)', [id])) {
    if (a.file) fs.rmSync(path.join(attachDir, a.file), { force: true });
  }
  run('DELETE FROM sessions WHERE id = ?', [id]);
}

/** The whole session: its turns (with attachments re-read from disk) and transcript. */
function loadSession(id) {
  const s = one('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!s) return null;
  const turns = all('SELECT * FROM turns WHERE session_id = ? ORDER BY seq', [id]).map((t) => ({
    id: t.id, question: t.question, prompt: t.prompt, answer: t.answer, error: t.error || null, at: t.at,
    attachments: all('SELECT * FROM attachments WHERE turn_id = ? ORDER BY id', [t.id]).map(readAttachment)
  }));
  const transcript = all('SELECT channel, text, at FROM transcript WHERE session_id = ? ORDER BY at, id', [id]);
  return { session: { id: s.id, profileId: s.profile_id, title: s.title, startedAt: s.started_at, endedAt: s.ended_at }, turns, transcript };
}

function readAttachment(a) {
  const out = { id: a.id, kind: a.kind, name: a.name, mime: a.mime };
  if (a.kind === 'text') out.text = a.text || '';
  else if (a.file) {
    try {
      out.data = fs.readFileSync(path.join(attachDir, a.file)).toString('base64');
      if (a.kind === 'image') out.preview = `data:${a.mime};base64,${out.data}`;
    } catch { out.missing = true; }
  }
  return out;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Appends one question/answer to a session. `attachments` as produced by renderer/attach.js. */
function addTurn(sessionId, { question, prompt, answer, error, at, attachments = [] }) {
  const seq = (one('SELECT coalesce(max(seq), 0) AS m FROM turns WHERE session_id = ?', [sessionId]).m || 0) + 1;
  run('INSERT INTO turns (session_id, seq, question, prompt, answer, error, at) VALUES (?,?,?,?,?,?,?)',
    [sessionId, seq, question || '', prompt || '', answer || '', error || null, at || now()]);
  const turnId = lastId();
  attachments.forEach((a, i) => {
    let file = null;
    if (a.kind !== 'text' && a.data) {
      file = `${sessionId}-${turnId}-${i + 1}.${EXT[a.mime] || 'bin'}`;
      fs.writeFileSync(path.join(attachDir, file), Buffer.from(a.data, 'base64'));
    }
    run('INSERT INTO attachments (turn_id, kind, name, mime, file, text) VALUES (?,?,?,?,?,?)',
      [turnId, a.kind, a.name, a.mime, file, a.kind === 'text' ? a.text || '' : null]);
  });
  run('UPDATE sessions SET last_active = ? WHERE id = ?', [now(), sessionId]);
  return turnId;
}

/** A retried question: replace the saved answer (question, time and attachments stay). */
function updateTurn(turnId, { prompt, answer, error }) {
  run('UPDATE turns SET prompt = coalesce(?, prompt), answer = ?, error = ? WHERE id = ?',
    [prompt ?? null, answer || '', error || null, turnId]);
  const t = one('SELECT session_id FROM turns WHERE id = ?', [turnId]);
  if (t) run('UPDATE sessions SET last_active = ? WHERE id = ?', [now(), t.session_id]);
  return turnId;
}

function addTranscript(sessionId, { channel, text, at }) {
  run('INSERT INTO transcript (session_id, channel, text, at) VALUES (?,?,?,?)', [sessionId, channel, text, at || now()]);
}

module.exports = {
  open, close, flush, PROFILE_FIELDS,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  listSessions, createSession, renameSession, endSession, deleteSession, loadSession, addTurn, updateTurn, addTranscript
};
