const express = require('express');
const { OpenAI } = require('openai');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ========== 管理員ID清單，兩組都擁有管理員指令權限 ==========
const ADMIN_USER_LIST = [
  "Ubd8313c23ee1aaf9f794042649c176fe",
  "Ua25feb59dc428d5bdb78f0d44192dcd3"
];
let globalAiSwitch = true; // 全域AI開關，容器重啟會恢復true

// ========== 新增：以UID隔離的RAM記憶，伺服器重啟全部清空 ==========
const chatMemory = {};

// ========== 讀取外部 System Prompt ==========
let systemPrompt;
try {
  systemPrompt = fs.readFileSync(
    path.join(__dirname, './prompts/customer.txt'),
    'utf8'
  );
} catch (err) {
  console.warn("無法載入prompts/customer.txt，使用內建備用prompt", err.message);
  systemPrompt = "你是萌爪貓坊的專業線上客服，態度親切有禮，使用繁體中文簡潔回覆客人關於貓咪品種、預約、飼養須知、等相關問題。回答不要過長。";
}

// ========== Agnes AI 接口配置 ==========
const aiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://apihub.agnes-ai.com/v1"
});

// ========== LINE Webhook 入口 ==========
app.post('/callback', async (req, res) => {
  res.status(200).end();

  const events = req.body.events;
  if (!events || events.length === 0) return;

  const event = events[0];
  // ✅完整輸出全部事件資訊到logs
  console.log("====完整事件資訊====", JSON.stringify(event,null,2));
  const userId = event.source.userId;

  // 管理員 #指令處理（嚴格比對 #暫停 / #開始）
  if(event.type === 'message' && event.message.type === 'text'){
    const msg = event.message.text.trim();
    // 判斷：#開頭，且userId存在管理員清單內
    if(msg.startsWith('#') && ADMIN_USER_LIST.includes(userId)){
      const lineClient = new line.Client({
        channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
        channelSecret: process.env.LINE_CHANNEL_SECRET
      });
      if(msg === '#暫停'){
        globalAiSwitch = false;
        try{
          await lineClient.pushMessage(userId, {
            type:"text",
            text:"✅已全域關閉AI自動回覆，所有人交由人工處理。容器重啟會自動恢復開啟。"
          })
        }catch(e){console.error("push訊息失敗",e)}
        return;
      }
      if(msg === '#開始'){
        globalAiSwitch = true;
        try{
          await lineClient.pushMessage(userId, {
            type:"text",
            text:"✅已開啟AI自動回覆。"
          })
        }catch(e){console.error("push訊息失敗",e)}
        return;
      }
    }
  }

  // 全域開關判斷，關閉就直接結束，不跑AI
  if(globalAiSwitch !== true){
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;

  const lineClient = new line.Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
  });

  const userText = event.message.text;

  // 處理該使用者的聊天記憶，按UID分開
  if(!chatMemory[userId]){
    chatMemory[userId] = [];
  }
  chatMemory[userId].push({role:"user", content: userText});

  try {
    const aiResponse = await aiClient.chat.completions.create({
      model: "agnes-2.5-flash",
      messages: [
        {role: "system", content: systemPrompt},
        ...chatMemory[userId] // 把該使用者全部歷史一起送給AI
      ],
      temperature: 0.3
    });

    const replyContent = aiResponse.choices[0]?.message?.content?.trim()
      || "很抱歉，目前無法處理您的問題，請稍後再嘗試。";

    // 把AI回覆存入記憶，下一輪可以讀取
    chatMemory[userId].push({role:"assistant", content: replyContent});

    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: replyContent
    });

  } catch (error) {
    console.error("AI 回覆異常:", error);
    try {
      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "不好意思，系統暫時忙碌，請稍後再聯繫我們。"
      });
    } catch (replyErr) {
      console.error("錯誤提示發送失敗:", replyErr);
    }
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`貓坊客服機器人已啟動，運行端口: ${PORT}`);
});
