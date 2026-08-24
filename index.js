const express = require('express');
const { OpenAI } = require('openai');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

// ========== 管理員 ID 清單 ==========
const ADMIN_USER_LIST = [
  "Ubd8313c23ee1aaf9f794042649c176fe",
  "Ua25feb59dc428d5bdb78f0d44192dcd3"
];
let globalAiSwitch = true;

// 使用者對話記憶
let chatMemory = {};

// ========== 讀取prompts資料夾下全部TXT ==========
let systemPrompt = "";
const promptDir = path.join(__dirname, './prompts');
try {
  const fileList = fs.readdirSync(promptDir);
  const txtFiles = fileList.filter(f => path.extname(f).toLowerCase() === '.txt');

  for (const filename of txtFiles) {
    const fullPath = path.join(promptDir, filename);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      systemPrompt += `\n===== ${filename} =====\n${content}\n`;
      console.log(`已載入prompt檔案: ${filename}`);
    } catch (errRead) {
      console.warn(`⚠️跳過檔案 ${filename}，讀取失敗:`, errRead.message);
    }
  }

  if (systemPrompt.trim() === "") {
    throw new Error("prompts資料夾沒有讀取到任何有效的txt內容");
  }

} catch (err) {
  console.warn("無法存取prompts資料夾，使用內建備用 prompt", err.message);
  systemPrompt = "你是萌爪貓坊的專業線上客服，態度親切有禮，使用繁體中文簡潔回覆客人關於貓咪品種、預約、飼養須知、等相關問題。回答不要過長。";
}

// ========== Agnes AI 客戶端 ==========
const aiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://apihub.agnes-ai.com/v1"
});

// 封裝：通知全部管理員
async function notifyAdmins(lineClient, userId, userRawText) {
  for (const adminUid of ADMIN_USER_LIST) {
    try {
      await lineClient.pushMessage({
        to: adminUid,
        messages: [{
          type: "text",
          text: `🔔AI觸發移交真人\n使用者UID：${userId}\n使用者訊息：${userRawText}`
        }]
      });
    } catch (e) {
      console.error("管理員推播失敗 adminUid=", adminUid, e);
    }
  }
}

// ========== 四層防禦：移交通知判斷 ==========
function shouldTriggerAdminAlert(rawAiOutput) {
  // 第二層：明確標記比對
  if (rawAiOutput.includes("<<trigger_admin_alert>>")) {
    return { triggered: true, reason: "標記觸發", stripMarker: true };
  }

  const text = rawAiOutput.toLowerCase();

  // 第三層：組合關鍵字兜底（必須同時命中兩個正則，避免單詞誤觸發）
  const patterns = [
    [/通知/, /真人|小編|客服|專人|人員/],
    [/已為您|已經幫您|幫您|已幫您/, /通知|轉交|移交|安排|聯繫/],
    [/稍後|等等|很快|隨後|一會兒/, /聯繫|回覆|有人|人員|跟您|找您/],
    [/馬上|立刻|立即|趕快|這就/, /有人|小編|真人|專人|客服|人員/],
    [/為您.*轉|幫您.*轉/, /真人|小編|客服|專人/],
  ];

  for (const [p1, p2] of patterns) {
    if (p1.test(text) && p2.test(text)) {
      return { triggered: true, reason: "關鍵字組合觸發", stripMarker: false };
    }
  }

  return { triggered: false, reason: "", stripMarker: false };
}

// ========== 完整句子截斷：避免回覆過長 ==========
function truncateToCompleteSentence(text, maxChars = 120, hardLimit = 150) {
  if (!text || text.length <= maxChars) return text;

  // 從 maxChars 開始找第一個句末標點（。！？!?），在標點後截斷
  const punctuation = /[。！？!?]/;
  let cutIndex = -1;
  const searchEnd = Math.min(text.length, hardLimit);
  for (let i = maxChars; i < searchEnd; i++) {
    if (punctuation.test(text[i])) {
      cutIndex = i + 1;
      break;
    }
  }

  if (cutIndex === -1) {
    // 找不到標點，在 hardLimit 處硬截斷
    cutIndex = Math.min(text.length, hardLimit);
  }

  return text.slice(0, cutIndex).trim() + "…";
}

// ========== LINE Webhook ==========
app.post('/callback', async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).end();
  }
  
  const event = events[0];
  console.log("==== 完整事件資訊 ====", JSON.stringify(event, null, 2));
  const userId = event.source.userId;

  const lineClient = new line.messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
  });

  // 管理員指令區
  if (event.type === 'message' && event.message.type === 'text') {
    const msg = event.message.text.trim();
    if (msg.startsWith('#') && ADMIN_USER_LIST.includes(userId)) {

      if (msg === '#暫停') {
        globalAiSwitch = false;
        try {
          await lineClient.pushMessage({
            to: userId,
            messages: [{ type: "text", text: "✅已全域關閉 AI 自動回覆，所有人交由人工處理。容器重啟會自動恢復開啟。" }]
          });
        } catch (e) { console.error("push 訊息失敗", e) }
        return res.status(200).end();
      }

      if (msg === '#開始') {
        globalAiSwitch = true;
        try {
          await lineClient.pushMessage({
            to: userId,
            messages: [{ type: "text", text: "✅已開啟 AI 自動回覆。" }]
          });
        } catch (e) { console.error("push 訊息失敗", e) }
        return res.status(200).end();
      }

      if (msg === '#重啟') {
        const oldCount = Object.keys(chatMemory).length;
        chatMemory = {};
        try {
          await lineClient.pushMessage({
            to: userId,
            messages: [{
              type: "text",
              text: `✅聊天記憶已全部清空\n本次開機累計使用者紀錄數：${oldCount}\n伺服器本身不會重啟，僅重置對話緩存\n⚠️注意：prompts資料夾的txt修改，需要重啟伺服器才會生效`
            }]
          });
        } catch (e) { console.error("push 訊息失敗", e) }
        return res.status(200).end();
      }
    }
  }

  // AI開關關閉直接結束
  if (globalAiSwitch !== true) {
    return res.status(200).end();
  }
  if (event.type !== 'message' || event.message.type !== 'text') {
    return res.status(200).end();
  }

  const userText = event.message.text;

  // 存入使用者訊息記憶
  if (!chatMemory[userId]) {
    chatMemory[userId] = [];
  }
  chatMemory[userId].push({ role: "user", content: userText });

  // 記憶長度防爆（保留最近 20 則歷史紀錄）
  if (chatMemory[userId].length > 20) {
    chatMemory[userId] = chatMemory[userId].slice(-20);
  }

  try {
    // 💡 自動多模型分流【全部小寫正確model id】
    let selectedModel = "agnes‑2.5‑flash"; 
    
    if (userText.length > 150 || chatMemory[userId].length >= 14) {
      selectedModel = "agnes‑2.5‑flash";
      console.log(`[🚀 模型自動升級] 偵測到複雜對話，此輪由 ${selectedModel} 為您服務。`);
    } else {
      console.log(`[⚡ 快速模式] 使用標準模型: ${selectedModel}`);
    }

    let aiResponse;
    try{
      aiResponse = await aiClient.chat.completions.create({
        model: selectedModel,
        messages: [
          { role: "system", content: systemPrompt },
          ...chatMemory[userId]
        ],
        temperature: 0.3,
        max_tokens: 350
      });
    }catch(modelErr){
      // 主模型失敗，強制降級到 flash
      console.warn(`⚠️模型 ${selectedModel} 呼叫失敗，自動降級至 agnes‑2.5‑flash`, modelErr.message);
      aiResponse = await aiClient.chat.completions.create({
        model: "agnes-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          ...chatMemory[userId]
        ],
        temperature: 0.3,
        max_tokens: 350
      });
    }

    const rawAiOutput = aiResponse.choices[0]?.message?.content?.trim()
      || "很抱歉，目前無法處理您的問題，請稍後再嘗試。";

    console.log(`【AI原始輸出 - 來自 ${aiResponse.model}】`, JSON.stringify(rawAiOutput));

    // 四層防禦：觸發移交通知判斷
    let finalUserText = rawAiOutput;
    const alertResult = shouldTriggerAdminAlert(rawAiOutput);
    if (alertResult.triggered) {
      console.log(`偵測到移交通知 [${alertResult.reason}]，通知管理員`);
      await notifyAdmins(lineClient, userId, userText);
      if (alertResult.stripMarker) {
        finalUserText = finalUserText.replaceAll("<<trigger_admin_alert>>", "").trim();
      }
    }

    // 長度控制：超過120字在完整句子處截斷
    finalUserText = truncateToCompleteSentence(finalUserText);

    chatMemory[userId].push({ role: "assistant", content: finalUserText });

    // 回覆訊息給 LINE 使用者
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: "text",
        text: finalUserText
      }]
    });

  } catch (error) {
    console.error("AI 回覆異常:", error);
    try {
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: "text",
          text: "不好意思，系統暫時忙碌，請稍後再聯繫我們。"
        }]
      });
    } catch (replyErr) {
      console.error("錯誤提示發送失敗:", replyErr);
    }
  }

  res.status(200).end();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`貓坊客服機器人已啟動，運行端口: ${PORT}`);
});
