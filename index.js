require('dotenv').config();
const express = require('express');
const app = express();
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/audio', express.static(path.join(__dirname, 'audio')));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const conversationHistory = {};

if (!fs.existsSync('./audio')) fs.mkdirSync('./audio');

// OpenAI TTS se audio generate karo
async function generateSpeech(text, filename) {
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'nova', // Female voice — Nour ke liye perfect
    input: text,
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  fs.writeFileSync(`./audio/${filename}.mp3`, buffer);
}

app.get('/', (req, res) => {
  res.send('FM Agent Server Running!');
});

app.post('/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid;
  conversationHistory[callSid] = [];

  const greetingText = "Assalamu Alaikum! Thank you for calling Al Qiraat Al Jadedah Technical Services. This is Nour speaking, how may I help you today?";

  try {
    await generateSpeech(greetingText, callSid + '_greeting');
    const audioUrl = `${process.env.SERVER_URL}/audio/${callSid}_greeting.mp3`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather input="speech" action="/respond" speechTimeout="3" language="en-IN"/>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  } catch (err) {
    console.error('TTS error:', err.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${greetingText}</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" language="en-IN"/>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  }
});

app.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';

  console.log('User said:', userSpeech);

  if (!userSpeech || userSpeech.trim() === '') {
    const sorryText = "I'm sorry, I didn't catch that. Could you please repeat?";
    try {
      await generateSpeech(sorryText, callSid + '_sorry');
      const audioUrl = `${process.env.SERVER_URL}/audio/${callSid}_sorry.mp3`;
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather input="speech" action="/respond" speechTimeout="3" language="en-IN"/>
</Response>`;
      res.type('text/xml');
      return res.send(twiml);
    } catch {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${sorryText}</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" language="en-IN"/>
</Response>`;
      res.type('text/xml');
      return res.send(twiml);
    }
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
- MOST IMPORTANT: Always reply in the EXACT same language the customer uses. Examples:
  * Customer speaks Hindi → You reply in Hindi only
  * Customer speaks English → You reply in English only
  * Customer speaks Arabic → You reply in Arabic only
  * If customer switches language → You also switch language immediately
- Be warm, friendly and professional.
- Keep responses short — maximum 2 sentences.
- Only say "Thank you for calling Al Qiraat Al Jadedah Technical Services. Goodbye!" when customer explicitly says they want to end the call.`
        },
        ...conversationHistory[callSid]
      ],
      max_tokens: 150
    });

    const aiResponse = completion.choices[0].message.content;
    conversationHistory[callSid].push({ role: 'assistant', content: aiResponse });
    console.log('Nour said:', aiResponse);

    const shouldHangup = /\bGoodbye\b/i.test(aiResponse) && /\bThank you for calling\b/i.test(aiResponse);

    await generateSpeech(aiResponse, callSid + '_response');
    const audioUrl = `${process.env.SERVER_URL}/audio/${callSid}_response.mp3`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  ${shouldHangup ? '<Hangup/>' : '<Gather input="speech" action="/respond" speechTimeout="3" language="en-IN"/>'}
</Response>`;

    res.type('text/xml');
    res.send(twiml);

  } catch (error) {
    console.error('Error:', error.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Sorry, I could not process that. Please try again.</Say>
  <Gather input="speech" action="/respond" speechTimeout="3" language="en-IN"/>
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