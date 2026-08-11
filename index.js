const express = require('express');
const line = require('@line/bot-sdk');
const { OpenAI } = require('openai');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new line.Client(lineConfig);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post('/callback', line.middleware(lineConfig), async (req, res) => {
  res.status(200).end();
  const event = req.body.events[0];
  if(event.type !== 'message' || event.message.type !== 'text') return;

  const userText = event.message.text;

  try {
    const aiRes = await openai.chat.completions.create({
      model:"gpt-3.5-turbo",
      messages:[
        {role:"system",content:"你是萌爪貓坊客服，回答簡短親切，圍繞貓咪諮詢、預約看貓。"},
        {role:"user",content:userText}
      ],
      max_tokens:350
    });
    const replyText = aiRes.choices[0].message.content.trim();
    await client.replyMessage(event.replyToken, {type:'text', text:replyText});
  }catch(err){
    console.error(err);
    await client.replyMessage(event.replyToken, {type:'text', text:"不好意思，暫時無法回覆，請稍後再試。"});
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{
  console.log(`伺服器啟動，port:${PORT}`);
});
