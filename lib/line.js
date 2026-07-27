const crypto = require("crypto");
const { messagingApi } = require("@line/bot-sdk");

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

function validateLineSignature(rawBody, signature) {
  if (!signature || !process.env.LINE_CHANNEL_SECRET) return false;

  const expected = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");

  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return false;

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function replyText(replyToken, text) {
  await client.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

module.exports = {
  validateLineSignature,
  replyText,
};
