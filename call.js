require('dotenv').config();
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

client.calls.create({
  url: 'https://fm-agent.onrender.com/incoming-call'
  to: '+971505683408'
  from: '+17015878090'
}).then(c => console.log('Calling!', c.sid))
  .catch(e => console.error('Error:', e.message));