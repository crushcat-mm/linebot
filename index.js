const express = require('express');
const { messagingApi, WebhookEvent } = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Render環境變數
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ✅官方 @line/bot-sdk
const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN
});

const aiClient = new (require('openai').OpenAI)({
  apiKey: OPENAI_API_KEY,
  baseURL: "https://api.agnes-ai.com/v1"
});

//管理員UID
const ADMIN_USER_LIST = [
  "Ubd8313c23ee1aaf9f794042649c176fe",
  "Ua25feb59dc428d5bdb78f0d44192dcd3"
];

const chatMemory = {};
const TRIGGER_MARKER = "<<trigger_admin_alert>>";

//讀取同資料夾 customer.txt，你的index在src/，txt也要丟src/
let systemPrompt;
try {
  systemPrompt = fs.readFileSync(path.join(__dirname,"prompts","customer.txt"),"utf8");
}catch(e){
  console.error("讀取customer.txt失敗:",e);
  systemPrompt = "你是萌爪貓坊客服";
}

//Webhook接口
app.post('/webhook',async (req,res)=>{
  res.status(200).send("ok");
  const events = req.body.events;

  for(const event of events){
    if(event.type !== "message" || event.message.type !== "text") continue;
    const userId = event.source.userId;
    const userText = event.message.text.trim();

    if(!chatMemory[userId]) chatMemory[userId] = [];
    chatMemory[userId].push({role:"user", content: userText});

    try{
      const aiResp = await aiClient.chat.completions.create({
        model:"agnes-2.5-pro-alpha",
        messages:[
          {role:"system", content: systemPrompt},
          ...chatMemory[userId]
        ],
        temperature:0.3
      });

      let replyText = aiResp.choices[0]?.message?.content?.trim() || "暫時無法回覆，請稍後再試";
      let needAlert = false;

      if(replyText.startsWith(TRIGGER_MARKER)){
        needAlert = true;
        replyText = replyText.slice(TRIGGER_MARKER.length).trim();
      }

      chatMemory[userId].push({role:"assistant", content: replyText});

      //推播給管理員
      if(needAlert){
        const notifyMsg = `⚠️客服觸發強制管理員介入\n使用者UID:${userId}\n使用者訊息:${userText}`;
        for(const adminUid of ADMIN_USER_LIST){
          try{
            await lineClient.pushMessage({
              to: adminUid,
              messages: [{type:"text", text: notifyMsg}]
            });
          }catch(err){
            console.error("管理員推播失敗 uid:"+adminUid, err);
          }
        }
      }

      //回覆使用者
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{type:"text", text: replyText}]
      });

    }catch(err){
      console.error("AI呼叫錯誤",err);
      try{
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{type:"text", text:"不好意思，系統暫時忙碌，請稍後再聯繫我們。"}]
        })
      }catch(e){}
    }
  }
})

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>{
  console.log("伺服器啟動 port:"+PORT);
})
