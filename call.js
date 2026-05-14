require('dotenv').config();
const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

console.log('SID:', accountSid ? accountSid.substring(0,10) + '...' : 'NOT FOUND');
console.log('Token:', authToken ? authToken.substring(0,5) + '...' : 'NOT FOUND');

const client = twilio(accountSid, authToken);

client.calls.create({
  url: 'https://fm-agent.onrender.com/incoming-call',
  to: '+919693231307',
  from: '+17015878090'
}).then(c => console.log('Calling!', c.sid))
  .catch(e => console.error('Error:', e.message));