require('dotenv').config();
const express = require('express');
const app = express();
const OpenAI = require('openai');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const conversationHistory = {};

app.get('/', (req, res) => {
  res.send('FM Agent Server Running!');
});

app.post('/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid;
  conversationHistory[callSid] = [];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="hi-IN">Assalamu Alaikum! Al Qiraat Al Jadedah Technical Services mein aapka swagat hai. Main Nour bol rahi hun, aap ki kya madad kar sakti hun?</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" language="hi-IN"/>
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
  <Say voice="Polly.Aditi" language="hi-IN">Mujhe suna nahi, kya aap dobara bol sakte hain?</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" language="hi-IN"/>
</Response>`;
    res.type('text/xml');
    return res.send(twiml);
  }

  if (!conversationHistory[callSid]) conversationHistory[callSid] = [];
  conversationHistory[callSid].push({ role: 'user', content: userSpeech });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
- Keep responses short — maximum 2 sentences.
- Only say "Thank you for calling. Goodbye!" when customer explicitly says they want to end the call.`
        },
        ...conversationHistory[callSid]
      ],
      max_tokens: 150
    });

    const aiResponse = completion.choices[0].message.content;
    conversationHistory[callSid].push({ role: 'assistant', content: aiResponse });
    console.log('Nour said:', aiResponse);

    const shouldHangup = /\bGoodbye\b/i.test(aiResponse);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="hi-IN">${aiResponse}</Say>
  ${shouldHangup ? '<Hangup/>' : '<Gather input="speech" action="/respond" speechTimeout="3" language="hi-IN"/>'}
</Response>`;

    res.type('text/xml');
    res.send(twiml);

  } catch (error) {
    console.error('Error:', error.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">Sorry, please try again.</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" language="hi-IN"/>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FM Agent server running on port ${PORT}`);
  console.log('Nour is ready to take calls!');
});