const express = require ('express');
const { OpenAI } = require ('openai');
const line = require ('@line/bot-sdk');
const fs = require ('fs');
const path = require ('path');
const app = express();
app.use(express.json());

// ========== 管理員 ID 清單 ==========
const ADMIN_USER_LIST = [
"Ubd8313c23ee1aaf9f794042649c176fe",
"Ua25feb59dc428d5bdb78f0d44192dcd3"
];
let globalAiSwitch = true;

// 使用者對話記憶
const chatMemory = {};

// ========== 讀取prompts資料夾下全部TXT，單檔失敗直接跳過，不影響其他檔案 ==========
let systemPrompt = "";
const promptDir = path.join(__dirname, './prompts');
try {
    const fileList = fs.readdirSync(promptDir);
    const txtFiles = fileList.filter(f => path.extname(f).toLowerCase() === '.txt');

    for(const filename of txtFiles){
        const fullPath = path.join(promptDir, filename);
        try{
            const content = fs.readFileSync(fullPath, 'utf8');
            systemPrompt += `\n===== ${filename} =====\n${content}\n`;
            console.log(`已載入prompt檔案: ${filename}`);
        }catch(errRead){
            console.warn(`⚠️跳過檔案 ${filename}，讀取失敗:`, errRead.message);
        }
    }

    if(systemPrompt.trim() === ""){
        throw new Error("prompts資料夾沒有讀取到任何有效的txt內容");
    }

} catch (err) {
    console.warn ("無法存取prompts資料夾，使用內建備用 prompt", err.message);
    systemPrompt = "你是萌爪貓坊的專業線上客服，態度親切有禮，使用繁體中文簡潔回覆客人關於貓咪品種、預約、飼養須知、等相關問題。回答不要過長。";
}

// ========== Agnes AI 客戶端 ==========
const aiClient = new OpenAI ({
apiKey: process.env.OPENAI_API_KEY,
baseURL: "https://apihub.agnes-ai.com/v1"
});

// 封裝：通知全部管理員【完全保留，不做任何修改】
async function notifyAdmins(lineClient, userId, userRawText){
    for(const adminUid of ADMIN_USER_LIST){
        try{
            await lineClient.pushMessage(adminUid,{
                type:"text",
                text:`🔔AI觸發移交真人\n使用者UID：${userId}\n使用者訊息：${userRawText}`
            })
        }catch(e){
            console.error("管理員推播失敗 adminUid=",adminUid,e);
        }
    }
}

// ========== LINE Webhook ==========
app.post ('/callback', async (req, res) => {
res.status (200).end ();
const events = req.body.events;
if (!events || events.length === 0) return;
const event = events [0];
console.log ("==== 完整事件資訊 ====", JSON.stringify (event,null,2));
const userId = event.source.userId;

// 管理員指令區
if (event.type === 'message' && event.message.type === 'text'){
const msg = event.message.text.trim ();
if (msg.startsWith ('#') && ADMIN_USER_LIST.includes (userId)){
const lineClient = new line.Client ({
channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
channelSecret: process.env.LINE_CHANNEL_SECRET
});

if (msg === '#暫停'){
globalAiSwitch = false;
try {
await lineClient.pushMessage (userId, {
type:"text",
text:"✅已全域關閉 AI 自動回覆，所有人交由人工處理。容器重啟會自動恢復開啟。"
})
} catch (e){console.error ("push 訊息失敗",e)}
return;
}

if (msg === '#開始'){
globalAiSwitch = true;
try {
await lineClient.pushMessage (userId, {
type:"text",
text:"✅已開啟 AI 自動回覆。"
})
} catch (e){console.error ("push 訊息失敗",e)}
return;
}

// 新增 #重啟：清空本次開機累積所有聊天記憶
if (msg === '#重啟'){
    const oldCount = Object.keys(chatMemory).length;
    chatMemory = {};
    try {
        await lineClient.pushMessage(userId,{
            type:"text",
            text:`✅聊天記憶已全部清空\n本次開機累計使用者紀錄數：${oldCount}\n伺服器本身不會重啟，僅重置對話緩存\n⚠️注意：prompts資料夾的txt修改，需要重啟伺服器才會生效`
        })
    }catch(e){console.error("push 訊息失敗",e)}
    return;
}

}
}

// AI開關關閉直接結束
if (globalAiSwitch !== true){
return;
}
if (event.type !== 'message' || event.message.type !== 'text') return;

const lineClient = new line.Client({
channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
channelSecret: process.env.LINE_CHANNEL_SECRET
});
const userText = event.message.text;

// 存入使用者訊息記憶
if (!chatMemory [userId]){
chatMemory [userId] = [];
}
chatMemory [userId].push ({role:"user", content: userText});

try {
const aiResponse = await aiClient.chat.completions.create ({
model: "Agnes-Image-2.0-Flash",
messages: [
{role: "system", content: systemPrompt},
...chatMemory [userId]
],
temperature: 0.3
});

const rawAiOutput = aiResponse.choices [0]?.message?.content?.trim ()
|| "很抱歉，目前無法處理您的問題，請稍後再嘗試。";

console.log("【AI原始輸出】", JSON.stringify(rawAiOutput));

// 觸發移交通知判斷
let finalUserText = rawAiOutput;
if(rawAiOutput.includes("<<trigger_admin_alert>>")){
    console.log("偵測到trigger_admin_alert，通知管理員");
    await notifyAdmins(lineClient, userId, userText);
    finalUserText = finalUserText.replaceAll("<<trigger_admin_alert>>","").trim();
}

chatMemory [userId].push ({role:"assistant", content: finalUserText});

await lineClient.replyMessage(event.replyToken, {
type: "text",
text: finalUserText
});

} catch (error) {
console.error ("AI 回覆異常:", error);
try {
await lineClient.replyMessage (event.replyToken, {
type: "text",
text: "不好意思，系統暫時忙碌，請稍後再聯繫我們。"
});
} catch (replyErr) {
console.error ("錯誤提示發送失敗:", replyErr);
}
}
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log(`貓坊客服機器人已啟動，運行端口: ${PORT}`);
});
