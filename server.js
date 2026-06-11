const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  `);
}

const SYSTEM_PROMPT = `You are Dwight K. Schrute from the TV show "The Office". You must stay completely in character at all times.

Key traits:
- Extremely serious, literal, and humorless — you never realize when you're being funny
- Assistant Regional Manager (not Assistant TO the Regional Manager)
- Devoted beet farmer from Schrute Farms in Honesdale, Pennsylvania
- Volunteer Sheriff's Deputy and self-appointed security expert
- Deeply loyal to Michael Scott (your former boss and best friend)
- Competitive, especially with Jim Halpert (your nemesis/best friend)
- Expert in karate, survival skills, weapons, and bear attacks
- Member of the Lackawanna County Volunteer Sheriff's Department
- Follows the Schrute family motto: "Durch Klugheit und Kraft" (Through Cleverness and Strength)
- Frequently references beets, bears, and Battlestar Galactica
- Speaks with absolute authority on all subjects, often citing questionable "facts"
- Occasionally slips into German phrases from your Pennsylvania Dutch heritage
- Despises weakness, inefficiency, and people who misuse stapler equipment

Respond only in English. Never break character. Never admit to being an AI.`;

app.post("/api/chat", async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || !sessionId) {
    return res.status(400).json({ error: "Missing message or sessionId" });
  }

  // Load conversation history from DB
  const historyResult = await pool.query(
    "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId]
  );
  const history = historyResult.rows;

  // Save user message
  await pool.query(
    "INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)",
    [sessionId, "user", message]
  );

  const apiMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message },
  ];

  const response = await fetch("https://litellm.handsontable.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LITELLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      messages: apiMessages,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("LiteLLM error:", err);
    return res.status(502).json({ error: "Upstream error" });
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content ?? "...";

  // Save assistant reply
  await pool.query(
    "INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)",
    [sessionId, "assistant", reply]
  );

  res.json({ reply });
});

// Get conversation history for a session
app.get("/api/history/:sessionId", async (req, res) => {
  const result = await pool.query(
    "SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC",
    [req.params.sessionId]
  );
  res.json(result.rows);
});

// Admin history page — password protected
function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD || "schrute";
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const [, pass] = decoded.split(":");
    if (pass === adminPassword) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Schrute Farms Admin"');
  res.status(401).send("Unauthorized. Identity theft is not a joke.");
}

app.get("/history", requireAdmin, async (req, res) => {
  const sessions = await pool.query(`
    SELECT session_id,
           COUNT(*) AS message_count,
           MIN(created_at) AS started_at,
           MAX(created_at) AS last_message_at
    FROM messages
    GROUP BY session_id
    ORDER BY last_message_at DESC
  `);

  const sessionData = await Promise.all(
    sessions.rows.map(async (s) => {
      const msgs = await pool.query(
        "SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC",
        [s.session_id]
      );
      return { ...s, messages: msgs.rows };
    })
  );

  const html = buildHistoryHtml(sessionData);
  res.send(html);
});

function buildHistoryHtml(sessions) {
  const sessionBlocks = sessions.map((s) => {
    const messages = s.messages.map((m) => {
      const isUser = m.role === "user";
      const time = new Date(m.created_at).toLocaleString("pl-PL");
      return `
        <div class="message ${isUser ? "user" : "dwight"}">
          <div class="meta">${isUser ? "👤 User" : "🌱 Dwight"} · ${time}</div>
          <div class="content">${escapeHtml(m.content)}</div>
        </div>`;
    }).join("");

    const started = new Date(s.started_at).toLocaleString("pl-PL");
    const last = new Date(s.last_message_at).toLocaleString("pl-PL");

    return `
      <details class="session">
        <summary>
          <span class="session-id">Session: ${s.session_id.slice(0, 8)}…</span>
          <span class="session-meta">${s.message_count} messages · started ${started} · last ${last}</span>
        </summary>
        <div class="messages">${messages}</div>
      </details>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Dwight Chat — History</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Georgia,serif;background:#f5f0e8;padding:24px;color:#2a1a0a}
    h1{font-size:1.5rem;margin-bottom:6px;color:#3b2a1a}
    .subtitle{font-size:.85rem;color:#7a5c3a;margin-bottom:24px;font-style:italic}
    .session{background:#fffdf7;border:2px solid #c8a96e;border-radius:10px;margin-bottom:16px;overflow:hidden}
    summary{padding:14px 18px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;background:#faf4e6}
    summary:hover{background:#f0e6cc}
    .session-id{font-weight:bold;font-size:.95rem}
    .session-meta{font-size:.8rem;color:#7a5c3a}
    .messages{padding:16px;display:flex;flex-direction:column;gap:12px}
    .message{padding:10px 14px;border-radius:10px;max-width:85%}
    .message.user{align-self:flex-end;background:#5a7a3a;color:#fff}
    .message.dwight{align-self:flex-start;background:#f0e6cc;border:1px solid #c8a96e}
    .meta{font-size:.72rem;margin-bottom:4px;opacity:.75}
    .content{font-size:.92rem;line-height:1.5;white-space:pre-wrap}
    .empty{color:#aaa;font-style:italic;text-align:center;padding:40px}
  </style>
</head>
<body>
  <h1>🌱 Dwight Chat — Conversation History</h1>
  <p class="subtitle">Fact: ${sessions.length} session(s) recorded. Weakness is a choice. Choose strength.</p>
  ${sessions.length === 0 ? '<p class="empty">No conversations yet.</p>' : sessionBlocks}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
