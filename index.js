require('dotenv').config();
const express = require('express');
const app = express();
const Groq = require('groq-sdk');
const axios = require('axios');
const twilio = require('twilio');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — Dashboard ke liye zaroori
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversationHistory = {};
const callData = {};

// ============================================
// PHASE 4 — DASHBOARD STATE
// ============================================
let callHistory = [];       // Sab calls ka record
let liveClients = [];       // SSE connected clients
let currentScript = {
  greeting: "Assalamu Alaikum! Thank you for calling Al Qiraat Al Jadedah Technical Services. This is Nour speaking, how may I help you today?",
  greetingArabic: "السلام عليكم! أهلاً وسهلاً بكم في شركة القراءات الجديدة. أنا نور، كيف يمكنني مساعدتك؟",
  personality: `Your name is Nour. You work as a customer service representative for Al Qiraat Al Jadedah Technical Services, a Facility Management company in UAE.

Important rules:
- You are a human customer service representative. Never say you are an AI, robot, or program.
- If anyone asks if you are an AI or robot, say "No, I am Nour, a customer service representative."
- MOST IMPORTANT: Always reply in the EXACT same language the customer uses:
  * Customer speaks Hindi → Reply in Hindi only
  * Customer speaks English → Reply in English only
  * Customer speaks Arabic → Reply in Arabic only
- Be warm, friendly and professional.
- Keep responses very short — maximum 1-2 sentences.
- Only say "Thank you for calling. Goodbye!" when customer explicitly uses words like "bye", "goodbye", "end call".`,
  closing: "Shukriya! AQAJ se contact karne ke liye bahut dhanyawad. Allah Hafiz!",
  triggerWords: "goodbye, bye, khuda hafiz, allah hafiz, ma'a salama, alvida"
};

// ============================================
// HELPER FUNCTIONS
// ============================================

// Call record save/update karo
function saveCallRecord(callSid, updates) {
  const existing = callHistory.find(c => c.callSid === callSid);
  if (existing) {
    Object.assign(existing, updates);
  } else {
    callHistory.push({ callSid, ...updates });
  }
}

// Live Monitor ko broadcast karo
function broadcastLive(data) {
  liveClients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
  });
}

// Duration format karo
function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ============================================
// ZOHO CRM FUNCTIONS (unchanged)
// ============================================

async function getZohoAccessToken() {
  const response = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN
    }
  });
  console.log('Zoho token response:', JSON.stringify(response.data));
  if (!response.data.access_token) {
    throw new Error('No access token: ' + JSON.stringify(response.data));
  }
  return response.data.access_token;
}

async function createZohoLead(phone, summary, duration) {
  try {
    console.log('Creating Zoho lead for:', phone);
    const token = await getZohoAccessToken();
    console.log('Zoho token received OK');
    const result = await axios.post(`${process.env.ZOHO_API_DOMAIN}/crm/v2/Leads`, {
      data: [{
        Last_Name: `Caller ${phone}`,
        Phone: phone,
        Lead_Source: 'Nour AI Agent',
        Description: summary,
        Company: 'Unknown',
      }]
    }, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('Zoho lead created successfully!', JSON.stringify(result.data));

    // Lead ID wapas lo
    const leadId = result.data?.data?.[0]?.details?.id || null;
    return leadId;

  } catch (err) {
    console.error('Zoho error:', err.message);
    console.error('Zoho full error:', JSON.stringify(err.response?.data));
    return null;
  }
}

// ============================================
// BASIC ROUTES
// ============================================

app.get('/', (req, res) => {
  res.send(`
    <h2>🤖 Nour AI Agent — Running!</h2>
    <p>Server: fm-agent.onrender.com</p>
    <p><a href="/dashboard">📊 Open Dashboard</a></p>
  `);
});

// Dashboard HTML file serve karo
app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/dashboard.html');
});

// Check environment variables
app.get('/check-env', (req, res) => {
  res.json({
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN ? process.env.TWILIO_AUTH_TOKEN.substring(0, 6) + '...' : 'NOT SET',
    phone: process.env.TWILIO_PHONE_NUMBER
  });
});

// ============================================
// EXISTING CALL ROUTES — UPDATED
// ============================================

app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || 'Unknown';

  conversationHistory[callSid] = [];
  callData[callSid] = {
    phone: callerPhone,
    startTime: new Date(),
    summary: ''
  };

  console.log('Incoming call from:', callerPhone, 'SID:', callSid);

  // ✅ PHASE 4: Call history mein save karo
  saveCallRecord(callSid, {
    callSid,
    from: callerPhone,
    to: req.body.To || process.env.TWILIO_PHONE_NUMBER,
    direction: 'inbound',
    startTime: new Date().toISOString(),
    duration: 0,
    summary: '',
    zohoLeadId: null,
    language: 'Auto'
  });

  // ✅ PHASE 4: Live monitor ko batao — call shuru
  broadcastLive({
    type: 'call_start',
    from: callerPhone,
    language: 'Detecting...'
  });

  const greetingMsg = currentScript.greeting;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${greetingMsg}</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" timeout="30" language="en-IN"/>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

app.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';

  console.log('User said:', userSpeech);

  if (!userSpeech || userSpeech.trim() === '') {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">I am sorry, I did not catch that. Could you please repeat?</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" timeout="30" language="en-IN"/>
</Response>`;
    res.type('text/xml');
    return res.send(twiml);
  }

  if (!conversationHistory[callSid]) conversationHistory[callSid] = [];
  conversationHistory[callSid].push({ role: 'user', content: userSpeech });

  if (callData[callSid]) {
    callData[callSid].summary += `Customer: ${userSpeech}\n`;
  }

  // ✅ PHASE 4: Customer ki baat live broadcast karo
  broadcastLive({
    type: 'message',
    role: 'user',
    text: userSpeech
  });

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: currentScript.personality  // ✅ PHASE 4: Script Editor se update hoga
        },
        ...conversationHistory[callSid]
      ],
      max_tokens: 100
    });

    const aiResponse = completion.choices[0].message.content;
    conversationHistory[callSid].push({ role: 'assistant', content: aiResponse });
    console.log('Nour said:', aiResponse);

    if (callData[callSid]) {
      callData[callSid].summary += `Nour: ${aiResponse}\n`;
    }

    // ✅ PHASE 4: Nour ka jawab live broadcast karo
    broadcastLive({
      type: 'message',
      role: 'assistant',
      text: aiResponse
    });

    const shouldHangup = /\bGoodbye\b/i.test(aiResponse);

    if (shouldHangup && callData[callSid]) {
      const duration = Math.floor((new Date() - callData[callSid].startTime) / 1000);
      console.log('Goodbye detected — creating Zoho lead');

      const zohoLeadId = await createZohoLead(
        callData[callSid].phone,
        callData[callSid].summary,
        duration
      );

      // ✅ PHASE 4: Call record update karo
      saveCallRecord(callSid, {
        duration,
        summary: callData[callSid].summary,
        zohoLeadId
      });

      // ✅ PHASE 4: Live monitor ko batao — call khatam
      broadcastLive({ type: 'call_end' });

      delete callData[callSid];
      delete conversationHistory[callSid];
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${aiResponse}</Say>
  ${shouldHangup ? '<Hangup/>' : '<Gather input="speech" action="/respond" speechTimeout="3" timeout="30" language="en-IN"/>'}
</Response>`;

    res.type('text/xml');
    res.send(twiml);

  } catch (error) {
    console.error('Error:', error.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Sorry, please try again.</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" timeout="30" language="en-IN"/>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  }
});

app.post('/call-status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const callDuration = parseInt(req.body.CallDuration) || 0;

  console.log('Call status received:', callStatus, 'SID:', callSid);

  if (
    (callStatus === 'completed' || callStatus === 'no-answer' ||
     callStatus === 'canceled' || callStatus === 'failed') &&
    callData[callSid]
  ) {
    console.log('Creating Zoho lead from call-status webhook');

    const zohoLeadId = await createZohoLead(
      callData[callSid].phone,
      callData[callSid].summary || 'Call ended without conversation',
      callDuration
    );

    // ✅ PHASE 4: Final call record update karo
    saveCallRecord(callSid, {
      duration: callDuration,
      summary: callData[callSid].summary || 'Call ended without conversation',
      zohoLeadId,
      status: callStatus
    });

    // ✅ PHASE 4: Live monitor — call end
    broadcastLive({ type: 'call_end' });

    delete callData[callSid];
    delete conversationHistory[callSid];
  }

  res.sendStatus(200);
});

// ============================================
// PHASE 4 — DASHBOARD ROUTES
// ============================================

// 1. STATS
app.get('/dashboard/stats', (req, res) => {
  const today = new Date().toDateString();

  const todayCalls = callHistory.filter(c =>
    new Date(c.startTime).toDateString() === today
  ).length;

  const now = new Date();
  const monthCalls = callHistory.filter(c => {
    const d = new Date(c.startTime);
    return d.getMonth() === now.getMonth() &&
           d.getFullYear() === now.getFullYear();
  }).length;

  const inbound = callHistory.filter(c => c.direction === 'inbound').length;
  const outbound = callHistory.filter(c => c.direction === 'outbound').length;
  const withLeads = callHistory.filter(c => c.zohoLeadId).length;

  const totalDuration = callHistory.reduce((sum, c) => sum + (parseInt(c.duration) || 0), 0);
  const avgSecs = callHistory.length > 0 ? Math.round(totalDuration / callHistory.length) : 0;

  res.json({
    todayCalls,
    monthCalls,
    inbound,
    outbound,
    zohoLeads: withLeads,
    avgDuration: formatDuration(avgSecs),
    totalCalls: callHistory.length,
    recentCalls: callHistory.slice(-10).reverse()
  });
});

// 2. CALL HISTORY
app.get('/dashboard/calls', (req, res) => {
  res.json({
    calls: callHistory.slice().reverse(),
    total: callHistory.length
  });
});

// 3. OUTBOUND CALL
app.post('/dashboard/call', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.json({ success: false, error: 'Phone number required' });

  try {
    const call = await client.calls.create({
      url: `${process.env.SERVER_URL}/incoming-call`,
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER,
    });

    console.log('Outbound call made to:', to, 'SID:', call.sid);

    // Outbound call bhi history mein save karo
    saveCallRecord(call.sid, {
      callSid: call.sid,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to,
      direction: 'outbound',
      startTime: new Date().toISOString(),
      duration: 0,
      summary: '',
      zohoLeadId: null,
      language: 'Auto'
    });

    res.json({ success: true, callSid: call.sid });

  } catch (err) {
    console.error('Outbound call error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// 4. SCRIPT UPDATE
app.post('/dashboard/script', (req, res) => {
  const { greeting, greetingArabic, personality, closing, triggerWords } = req.body;

  if (greeting) currentScript.greeting = greeting;
  if (greetingArabic) currentScript.greetingArabic = greetingArabic;
  if (personality) currentScript.personality = personality;
  if (closing) currentScript.closing = closing;
  if (triggerWords) currentScript.triggerWords = triggerWords;

  console.log('✅ Nour script updated via dashboard');
  res.json({ success: true, message: 'Script updated! Next call will use new script.' });
});

// 5. LIVE MONITOR — SSE
app.get('/dashboard/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Connection confirm karo
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Live monitor active' })}\n\n`);

  // Heartbeat — connection alive rakhne ke liye
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
  }, 20000);

  liveClients.push(res);
  console.log(`👁️ Live client connected. Total: ${liveClients.length}`);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveClients = liveClients.filter(c => c !== res);
    console.log(`👁️ Live client disconnected. Total: ${liveClients.length}`);
  });
});

// 6. LIVE STATUS — Polling fallback
app.get('/dashboard/live-status', (req, res) => {
  const activeCalls = Object.keys(callData).length;
  res.json({
    type: activeCalls > 0 ? 'active' : 'idle',
    activeCalls,
    message: activeCalls > 0 ? 'Call in progress' : 'No active call'
  });
});

// ============================================
// PHASE 5 — ZOHO CRM WIDGET
// ============================================

app.get('/zoho-widget', (req, res) => {
  const phone = req.query.phone || '';
  const leadName = req.query.name || 'Customer';
  const leadId = req.query.id || '';

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nour AI Call</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #f0f4f8;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 30px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      text-align: center;
    }
    .logo {
      width: 70px;
      height: 70px;
      background: linear-gradient(135deg, #c9a84c, #a07830);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      margin: 0 auto 16px;
    }
    h2 { font-size: 20px; color: #1a1a2e; margin-bottom: 6px; }
    .subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
    .lead-info {
      background: #f8f9fa;
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 20px;
      text-align: left;
    }
    .lead-info label { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 1px; }
    .lead-info p { font-size: 15px; color: #1a1a2e; font-weight: 600; margin-top: 2px; }
    .phone-input {
      width: 100%;
      padding: 14px;
      border: 2px solid #e0e0e0;
      border-radius: 10px;
      font-size: 18px;
      text-align: center;
      margin-bottom: 16px;
      outline: none;
      font-family: monospace;
      letter-spacing: 2px;
    }
    .phone-input:focus { border-color: #c9a84c; }
    .call-btn {
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, #28a745, #1e7e34);
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .call-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(40,167,69,0.4); }
    .call-btn:disabled { background: #ccc; transform: none; box-shadow: none; cursor: not-allowed; }
    .status {
      margin-top: 16px;
      padding: 12px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      display: none;
    }
    .status.success { background: #d4edda; color: #155724; display: block; }
    .status.error { background: #f8d7da; color: #721c24; display: block; }
    .status.calling { background: #d1ecf1; color: #0c5460; display: block; }
    .footer { font-size: 11px; color: #999; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🤖</div>
    <h2>Nour AI Agent</h2>
    <p class="subtitle">Al Qiraat Al Jadedah Technical Services</p>

    <div class="lead-info">
      <label>Lead Name</label>
      <p id="lead-name">${leadName}</p>
    </div>

    <input type="tel" class="phone-input" id="phone-input"
      value="${phone}" placeholder="+971XXXXXXXXX">

    <button class="call-btn" id="call-btn" onclick="makeCall()">
      📞 Call with Nour
    </button>

    <div class="status" id="status"></div>

    <p class="footer">Nour will call the customer automatically</p>
  </div>

  <script>
    async function makeCall() {
      const phone = document.getElementById('phone-input').value.trim();
      const btn = document.getElementById('call-btn');
      const status = document.getElementById('status');

      if (!phone || phone.length < 8) {
        status.className = 'status error';
        status.textContent = '❌ Please enter a valid phone number';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '⏳ Calling...';
      status.className = 'status calling';
      status.textContent = '📞 Nour is calling ' + phone + '...';

      try {
        const response = await fetch('https://fm-agent.onrender.com/dashboard/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: phone })
        });

        const data = await response.json();

        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ Nour is calling ' + phone + '! Call SID: ' + data.callSid;
          btn.innerHTML = '✅ Call Initiated';
        } else {
          status.className = 'status error';
          status.textContent = '❌ Error: ' + (data.error || 'Unknown error');
          btn.disabled = false;
          btn.innerHTML = '📞 Call with Nour';
        }
      } catch (err) {
        status.className = 'status error';
        status.textContent = '❌ Connection error. Try again.';
        btn.disabled = false;
        btn.innerHTML = '📞 Call with Nour';
      }
    }
  </script>
</body>
</html>`);
});

// ============================================
// SERVER START
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FM Agent server running on port ${PORT}`);
  console.log('Nour is ready to take calls!');
  console.log(`Dashboard routes: /dashboard/stats, /dashboard/calls, /dashboard/call, /dashboard/script, /dashboard/live`);
});