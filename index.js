const express = require('express');
const { OpenAI } = require('openai');
const line = require('@line/bot-sdk');

const app = express();
app.use(express.json());

// Agnes 設定
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://apihub.agnes-ai.com/v1"
});

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.Client(lineConfig);

app.post('/callback', async (req, res) => {
  res.status(200).end();
  const event = req.body.events[0];
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userText = event.message.text;
  try {
    const aiRes = await openai.chat.completions.create({
      model: "agnes-2.5-flash",
      messages: [
        {role:"system", content:"你是萌爪貓坊客服(AI)，禮貌簡短回覆使用者問題。"},
        {role:"user", content: userText}
      ],
      temperature:0.7
    });
    const replyText = aiRes.choices[0].message.content.trim();
    await client.replyMessage(event.replyToken, {
      type:'text',
      text:replyText
    });
  } catch(err){
    console.error(err);
    await client.replyMessage(event.replyToken,{
      type:'text',
      text:"不好意思，暫時無法回應，請稍後再試。"
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT,()=>{
  console.log(`伺服器啟動，port:${PORT}`);
});
