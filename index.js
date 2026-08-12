const express = require('express');
const { OpenAI } = require('openai');
const line = require('@line/bot-sdk');

const app = express();
app.use(express.json());

// ========== Agnes AI 接口配置 ==========
const aiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://apihub.agnes-ai.com/v1"
});

// ========== LINE Webhook 入口 ==========
app.post('/callback', async (req, res) => {
  // 先回應 LINE 伺服器 200，避免逾時導致重複推送
  res.status(200).end();

  const events = req.body.events;
  if (!events || events.length === 0) return;

  const event = events[0];
  // 只處理文字類型的使用者訊息
  if (event.type !== 'message' || event.message.type !== 'text') return;

  // 收到訊息才初始化 LINE 用戶端，避免環境變數異常時伺服器直接崩潰
  const lineClient = new line.Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
  });

  const userText = event.message.text;

  try {
    // 呼叫 Agnes AI 生成客服回覆
    const aiResponse = await aiClient.chat.completions.create({
      model: "agnes-2.5-flash",
      messages: [
        {
          role: "system",
          content: "你是萌爪貓坊的專業線上客服，態度親切有禮，用繁體中文簡潔回覆客人關於貓咪品種、預約、飼養須知、價格等相關問題。"
        },
        {
          role: "user",
          content: userText
        }
      ],
      temperature: 0.7
    });

    const replyContent = aiResponse.choices[0]?.message?.content?.trim() 
      || "很抱歉，目前無法處理您的問題，請稍後再嘗試。";

    // 回覆使用者訊息
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: replyContent
    });

  } catch (error) {
    console.error("AI 回覆異常:", error);
    // 出錯時給使用者友好提示
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

// ========== 啟動伺服器 ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`貓坊客服機器人已啟動，運行端口: ${PORT}`);
});
