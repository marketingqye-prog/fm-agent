require('dotenv').config();
const express = require('express');
const app = express();
const Groq = require('groq-sdk');
const axios = require('axios');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const conversationHistory = {};
const callData = {};

// Zoho Access Token refresh karo
async function getZohoAccessToken() {
  const response = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN
    }
  });
  return response.data.access_token;
}

// Zoho mein Lead banao
async function createZohoLead(phone, summary, duration) {
  try {
    const token = await getZohoAccessToken();
    await axios.post(`${process.env.ZOHO_API_DOMAIN}/crm/v2/Leads`, {
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
    console.log('Zoho lead created for:', phone);
  } catch (err) {
    console.error('Zoho error:', err.message);
  }
}

app.get('/', (req, res) => {
  res.send('FM Agent Server Running!');
});

app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || 'Unknown';
  conversationHistory[callSid] = [];
  callData[callSid] = {
    phone: callerPhone,
    startTime: new Date(),
    summary: ''
  };

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Assalamu Alaikum! Thank you for calling Al Qiraat Al Jadedah Technical Services. This is Nour speaking, how may I help you today?</Say>
  <Gather input="speech" action="/respond" speechTimeout="2" timeout="10" language="en-IN"/>
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
  <Gather input="speech" action="/respond" speechTimeout="2" timeout="10" language="en-IN"/>
</Response>`;
    res.type('text/xml');
    return res.send(twiml);
  }

  if (!conversationHistory[callSid]) conversationHistory[callSid] = [];
  conversationHistory[callSid].push({ role: 'user', content: userSpeech });

  // Summary update karo
  if (callData[callSid]) {
    callData[callSid].summary += `Customer: ${userSpeech}\n`;
  }

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Your name is Nour. You work as a customer service representative for Al Qiraat Al Jadedah Technical Services, a Facility Management company in UAE.

Important rules:
- You are a human customer service representative. Never say you are an AI, robot, or program.
- If anyone asks if you are an AI or robot, say "No, I am Nour, a customer service representative."
- MOST IMPORTANT: Always reply in the EXACT same language the customer uses:
  * Customer speaks Hindi → Reply in Hindi only
  * Customer speaks English → Reply in English only
  * Customer speaks Arabic → Reply in Arabic only
- Be warm, friendly and professional.
- Keep responses very short — maximum 1-2 sentences.
- Only say "Thank you for calling. Goodbye!" when customer explicitly says they want to end the call.`
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

    const shouldHangup = /\bGoodbye\b/i.test(aiResponse);

    // Call khatam hone pe Zoho mein lead banao
    if (shouldHangup && callData[callSid]) {
      const duration = Math.floor((new Date() - callData[callSid].startTime) / 1000);
      await createZohoLead(
        callData[callSid].phone,
        callData[callSid].summary,
        duration
      );
      delete callData[callSid];
      delete conversationHistory[callSid];
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${aiResponse}</Say>
  ${shouldHangup ? '<Hangup/>' : '<Gather input="speech" action="/respond" speechTimeout="2" timeout="10" language="en-IN"/>'}
</Response>`;

    res.type('text/xml');
    res.send(twiml);

  } catch (error) {
    console.error('Error:', error.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Sorry, please try again.</Say>
  <Gather input="speech" action="/respond" speechTimeout="2" timeout="10" language="en-IN"/>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  }
});

// Call status webhook
app.post('/call-status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  if ((callStatus === 'completed' || callStatus === 'no-answer' || callStatus === 'canceled' || callStatus === 'failed') && callData[callSid]) {
    const duration = Math.floor((new Date() - callData[callSid].startTime) / 1000);
    await createZohoLead(
      callData[callSid].phone,
      callData[callSid].summary || 'Call ended without conversation',
      duration
    );
    delete callData[callSid];
    delete conversationHistory[callSid];
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FM Agent server running on port ${PORT}`);
  console.log('Nour is ready to take calls!');
});