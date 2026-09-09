async function sendDiscordNotification(webhookUrl, title, description, color = 0x5865F2, fields = [], imageBuffer = null, imageFilename = 'image.png', imageMimeType = 'image/png') {
  if (!webhookUrl) return false;
  try {
    const embed = {
      title, description, color,
      timestamp: new Date().toISOString(),
      fields,
      footer: { text: 'CandyBlast System' }
    };
    let res;
    if (imageBuffer) {
      // Discordのwebhookに画像を添付する場合、payload_json側に attachments 配列で
      // 「どのファイルがどのattachment idか」を明示しないと、画像が届かない/無視されることがある。
      embed.image = { url: `attachment://${imageFilename}` };
      const form = new FormData();
      form.append('payload_json', JSON.stringify({
        embeds: [embed],
        attachments: [{ id: 0, filename: imageFilename }]
      }));
      form.append('files[0]', new Blob([imageBuffer], { type: imageMimeType }), imageFilename);
      res = await fetch(webhookUrl, { method: 'POST', body: form });
    } else {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`Discord通知失敗: HTTP ${res.status} ${text}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Discord通知失敗:', err.message);
    return false;
  }
}

module.exports = { sendDiscordNotification };
