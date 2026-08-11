const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

// 憑證從 Render 環境變數讀取，**不要寫金鑰在這裡**
const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN
};

const client = new line.Client(config);

// webhook 路徑：後面 webhook 網址結尾是 /callback
app.post('/callback', line.middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

// 簡單回覆邏輯，使用者傳什麼文字，機器人就回覆同樣文字
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: event.message.text
  });
}

// Render 會自動給 PORT 環境變數，不能寫死3000
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器啟動，port:${port}`);
});