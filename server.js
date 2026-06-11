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

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
