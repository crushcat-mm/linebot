const express = require("express");
const { OpenAI } = require("openai");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "256kb" }));

// ==================== 基本設定 ====================
const PORT = process.env.PORT || 10000;
const MODEL_NAME = process.env.AI_MODEL || "agnes-2.5-flash";
const ADMIN_USER_LIST = [
  "Ubd8313c23ee1aaf9f794042649c176fe",
  "Ua25feb59dc428d5bdb78f0d44192dcd3"
];

let globalAiSwitch = true;
const chatMemory = new Map();
const processedEventIds = new Set();
const configuredMemoryMessages = Number.parseInt(process.env.MAX_MEMORY_MESSAGES || "60", 10);
const MAX_MEMORY_MESSAGES = Number.isFinite(configuredMemoryMessages)
  ? Math.min(Math.max(configuredMemoryMessages, 20), 100)
  : 60;
const MAX_TRACKED_EVENTS = 1000;

// ==================== 提示詞載入 ====================
// 不依賴檔案系統回傳順序，明確保留三份提示的職責與優先層級。
const PROMPT_FILES = [
  { name: "customer.txt", label: "主要銷售規則與輸出規範" },
  { name: "QA.txt", label: "QA 精確回答規則（優先於一般銷售規則）" },
  { name: "Function Button.txt", label: "LINE 按鈕說明（不可視為真正工具）" }
];

function loadSystemPrompt() {
  const promptDir = path.join(__dirname, "prompts");
  const sections = [];

  for (const file of PROMPT_FILES) {
    const fullPath = path.join(promptDir, file.name);
    try {
      const content = fs.readFileSync(fullPath, "utf8").trim();
      if (content) {
        sections.push(
          `===== ${file.name}｜${file.label} =====\n${content}`
        );
        console.log(`已載入 prompt 檔案：${file.name}`);
      }
    } catch (error) {
      console.warn(`跳過 prompt 檔案 ${file.name}：${error.message}`);
    }
  }

  if (sections.length === 0) {
    throw new Error("prompts 資料夾沒有讀取到任何有效的 txt 內容");
  }

  return [
    "【系統執行層】",
    "你只能產生最終可交付的 LINE 客戶訊息；不要輸出思考、草稿或規則檢查過程。",
    "QA.txt 的精確回答規則優先於一般銷售規則；customer.txt 負責銷售策略與輸出格式；Function Button.txt 只提供按鈕說明，不代表你真的擁有工具。",
    "若需要移交真人，必須使用下方 customer.txt 定義的移交格式；管理員摘要由伺服器擷取，不得留在客戶可見文字中。",
    ...sections
  ].join("\n\n");
}

let systemPrompt;
try {
  systemPrompt = loadSystemPrompt();
} catch (error) {
  console.error("提示詞載入失敗，使用備用規則：", error);
  systemPrompt = "你是萌爪貓坊的專業線上客服，使用繁體中文簡潔回答。無法確認的庫存、個體細節、價格與預約資訊，請誠實告知由真人確認。";
}

// ==================== 外部服務 ====================
const aiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_BASE || "https://apihub.agnes-ai.com/v1"
});

function getLineClient() {
  return new line.messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
  });
}

// ==================== UID 狀態與事件去重 ====================
function getUserSession(userId) {
  if (!chatMemory.has(userId)) {
    chatMemory.set(userId, {
      messages: [],
      turns: 0,
      handoverTriggered: false,
      lastAction: "尚未開始對話",
      lastHandoverReason: ""
    });
  }
  return chatMemory.get(userId);
}

function rememberMessage(session, message) {
  session.messages.push(message);
  if (session.messages.length > MAX_MEMORY_MESSAGES) {
    session.messages.splice(0, session.messages.length - MAX_MEMORY_MESSAGES);
  }
}

function markEventProcessed(event) {
  const eventId = event.webhookEventId;
  if (!eventId) return false;
  if (processedEventIds.has(eventId)) return true;
  processedEventIds.add(eventId);
  if (processedEventIds.size > MAX_TRACKED_EVENTS) {
    const first = processedEventIds.values().next().value;
    processedEventIds.delete(first);
  }
  return false;
}

// ==================== 移交判斷與輸出解析 ====================
function shouldTriggerAdminAlert(rawAiOutput) {
  if (rawAiOutput.includes("<<trigger_admin_alert>>")) {
    return { triggered: true, reason: "標記觸發", stripMarker: true };
  }

  const text = rawAiOutput.toLowerCase();
  const patterns = [
    [/通知/, /真人|小編|客服|專人|人員/],
    [/已為您|已經幫您|幫您|已幫您/, /通知|轉交|移交|安排|聯繫/],
    [/稍後|等等|很快|隨後|一會兒/, /聯繫|回覆|有人|人員|跟您|找您/],
    [/馬上|立刻|立即|趕快|這就/, /有人|小編|真人|專人|客服|人員/],
    [/為您.*轉|幫您.*轉/, /真人|小編|客服|專人/]
  ];

  for (const [first, second] of patterns) {
    if (first.test(text) && second.test(text)) {
      return { triggered: true, reason: "關鍵字組合觸發", stripMarker: false };
    }
  }

  return { triggered: false, reason: "", stripMarker: false };
}

function extractTextPart(value) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";

  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return part.text || part.content || part.value || "";
    })
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n")
    .trim();
}

function extractModelText(aiResponse) {
  const choice = aiResponse?.choices?.[0];
  const message = choice?.message;
  const candidates = [
    message?.content,
    choice?.text,
    aiResponse?.output_text
  ];

  for (const candidate of candidates) {
    const text = extractTextPart(candidate);
    if (text) return text;
  }

  return "";
}

function summarizeModelResponseShape(aiResponse) {
  const choice = aiResponse?.choices?.[0];
  const message = choice?.message;
  return {
    id: aiResponse?.id,
    model: aiResponse?.model,
    choices: Array.isArray(aiResponse?.choices) ? aiResponse.choices.length : 0,
    finishReason: choice?.finish_reason,
    messageKeys: message && typeof message === "object" ? Object.keys(message) : [],
    contentType: Array.isArray(message?.content) ? "array" : typeof message?.content,
    contentLength: typeof message?.content === "string" ? message.content.length : undefined,
    hasToolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
    hasRefusal: Boolean(message?.refusal),
    hasOutputText: typeof aiResponse?.output_text === "string"
  };
}

function parseAiOutput(rawOutput) {
  const raw = String(rawOutput || "").trim();
  const summaryMatch = raw.match(/<<admin_summary>>([\s\S]*?)<<end_admin_summary>>/i);
  const adminSummary = summaryMatch ? summaryMatch[1].trim() : "";
  const alert = shouldTriggerAdminAlert(raw);

  let customerText = raw
    // 完整標記或未閉合標記都不允許進入客戶訊息。
    .replace(/<<admin_summary>>[\s\S]*?(?:<<end_admin_summary>>|$)/gi, "")
    .replaceAll("<<trigger_admin_alert>>", "")
    .trim();

  if (!customerText || customerText.length === 1) {
    customerText = "我在喔～想先了解您比較喜歡哪種貓咪呢？";
  }

  return {
    customerText,
    adminSummary,
    triggered: alert.triggered,
    reason: alert.reason
  };
}

function truncateToCompleteSentence(text, maxChars = 220, hardLimit = 350) {
  if (!text || text.length <= maxChars) return text;
  const punctuation = /[。！？!?]/;
  const searchEnd = Math.min(text.length, hardLimit);
  let cutIndex = -1;

  for (let index = maxChars; index < searchEnd; index += 1) {
    if (punctuation.test(text[index])) {
      cutIndex = index + 1;
      break;
    }
  }

  if (cutIndex === -1) cutIndex = Math.min(text.length, hardLimit);
  return `${text.slice(0, cutIndex).trim()}…`;
}

// ==================== LINE 傳送 ====================
async function pushToAdmins(lineClient, userId, userRawText, summary, reason) {
  const text = [
    "🔔 AI 觸發移交真人",
    `使用者 UID：${userId}`,
    `移交原因：${reason || "模型判斷需真人接手"}`,
    `使用者訊息：${userRawText}`,
    summary ? `\n移交摘要：\n${summary}` : "\n移交摘要：模型未提供，請查看 LINE 對話紀錄。"
  ].join("\n");

  const results = await Promise.allSettled(
    ADMIN_USER_LIST.map((adminUid) =>
      lineClient.pushMessage({
        to: adminUid,
        messages: [{ type: "text", text: text.slice(0, 4900) }]
      })
    )
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error("管理員推播失敗：", ADMIN_USER_LIST[index], result.reason);
    }
  });
}

async function sendCustomerReply(lineClient, event, text) {
  const message = {
    type: "text",
    text: truncateToCompleteSentence(text)
  };

  try {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [message]
    });
  } catch (replyError) {
    console.error("LINE replyMessage 失敗：", {
      message: replyError.message,
      code: replyError.code,
      eventId: event.webhookEventId
    });

    // reply token 失效時，改用 pushMessage，避免客戶只看到系統錯誤。
    if (event.source?.userId) {
      try {
        await lineClient.pushMessage({
          to: event.source.userId,
          messages: [message]
        });
      } catch (pushError) {
        console.error("LINE fallback pushMessage 失敗：", pushError.message);
      }
    }
  }
}

// ==================== 管理員指令 ====================
async function handleAdminCommand(lineClient, userId, text) {
  if (!ADMIN_USER_LIST.includes(userId) || !text.startsWith("#")) {
    return false;
  }

  if (text === "#暫停") {
    globalAiSwitch = false;
    await lineClient.pushMessage({
      to: userId,
      messages: [{ type: "text", text: "✅已全域關閉 AI 自動回覆，所有人交由人工處理。容器重啟會自動恢復開啟。" }]
    });
    return true;
  }

  if (text === "#開始") {
    globalAiSwitch = true;
    await lineClient.pushMessage({
      to: userId,
      messages: [{ type: "text", text: "✅已開啟 AI 自動回覆。" }]
    });
    return true;
  }

  if (text === "#重啟") {
    const oldCount = chatMemory.size;
    chatMemory.clear();
    await lineClient.pushMessage({
      to: userId,
      messages: [{
        type: "text",
        text: `✅聊天記憶已全部清空\n本次開機累計使用者紀錄數：${oldCount}\n伺服器本身不會重啟，僅重置對話緩存\n⚠️注意：prompts 資料夾的 txt 修改，需要重啟伺服器才會生效`
      }]
    });
    return true;
  }

  return false;
}

// ==================== AI 對話流程 ====================
async function processTextEvent(event) {
  const userId = event.source?.userId;
  const userText = event.message?.text?.trim();
  if (!userId || !userText) return;

  const lineClient = getLineClient();
  if (await handleAdminCommand(lineClient, userId, userText)) return;
  if (!globalAiSwitch) return;

  const session = getUserSession(userId);
  const requesterRole = ADMIN_USER_LIST.includes(userId) ? "admin" : "customer";
  rememberMessage(session, { role: "user", content: userText });

  try {
    const stateContext = [
      "【目前執行狀態，僅供判斷，不要原樣輸出】",
      `requester_role: ${requesterRole}`,
      `conversation_turn: ${session.turns + 1}`,
      `handover_already_triggered: ${session.handoverTriggered ? "true" : "false"}`,
      `last_action: ${session.lastAction}`,
      "請依 customer.txt 的銷售流程處理本輪；若需要移交，依指定格式輸出。"
    ].join("\n");

    const aiResponse = await aiClient.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "system", content: stateContext },
        ...session.messages
      ],
      temperature: 0.3,
      max_tokens: 350
    });

    const rawAiOutput = extractModelText(aiResponse);
    if (!rawAiOutput) {
      console.error("模型回應格式無可用文字：", summarizeModelResponseShape(aiResponse));
      throw new Error("模型回傳沒有可用的文字內容");
    }

    const parsed = parseAiOutput(rawAiOutput);
    const visibleText = parsed.customerText.startsWith("萌爪小貓(AI)：")
      ? parsed.customerText
      : `萌爪小貓(AI)：\n\n${parsed.customerText}`;
    const finalUserText = truncateToCompleteSentence(visibleText);
    session.turns += 1;
    session.lastAction = parsed.triggered ? "已觸發真人移交" : "已完成本輪回覆";
    if (parsed.triggered) {
      session.handoverTriggered = true;
      session.lastHandoverReason = parsed.reason;
    }
    rememberMessage(session, { role: "assistant", content: finalUserText });

    // 先回覆客戶，移交推播在後台處理，不讓管理員通知拖住客戶回覆。
    await sendCustomerReply(lineClient, event, finalUserText);

    if (parsed.triggered) {
      void pushToAdmins(
        lineClient,
        userId,
        userText,
        parsed.adminSummary,
        parsed.reason
      ).catch((error) => {
        console.error("背景移交通知失敗：", error.message);
      });
    }
  } catch (error) {
    console.error("AI 回覆異常：", {
      message: error.message,
      code: error.code,
      status: error.status,
      userId,
      eventId: event.webhookEventId
    });

    // 移除本輪未完成的 user 訊息，避免下一輪把壞狀態持續累積。
    if (session.messages.at(-1)?.role === "user") {
      session.messages.pop();
    }

    await sendCustomerReply(
      lineClient,
      event,
      "不好意思，系統暫時忙碌，請稍後再聯繫我們。"
    );
  }
}

async function processEvent(event) {
  if (!event || markEventProcessed(event)) return;
  if (event.type !== "message" || event.message?.type !== "text") return;
  await processTextEvent(event);
}

// ==================== LINE Webhook ====================
app.post("/callback", (req, res) => {
  // 先確認 webhook，避免 LINE 等待模型、推播或回覆完成。
  res.status(200).end();

  const event = req.body?.events?.[0];
  if (!event) return;

  processEvent(event).catch((error) => {
    console.error("未處理的 webhook 例外：", error);
  });
});

app.get("/", (_req, res) => {
  res.status(200).send("LINE bot is running");
});

app.listen(PORT, () => {
  console.log(`貓坊客服機器人已啟動，運行端口：${PORT}`);
});
