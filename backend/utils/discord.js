async function sendDiscordNotification(webhookUrl, title, description, color = 0x5865F2, fields = [], imageBuffer = null, imageFilename = 'image.png') {
  if (!webhookUrl) return;
  try {
    const embed = {
      title, description, color,
      timestamp: new Date().toISOString(),
      fields,
      footer: { text: 'CandyBlast System' }
    };
    if (imageBuffer) {
      embed.image = { url: `attachment://${imageFilename}` };
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      form.append('file', new Blob([imageBuffer]), imageFilename);
      await fetch(webhookUrl, { method: 'POST', body: form });
    } else {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
    }
  } catch (err) {
    console.error('Discord通知失敗:', err.message);
  }
}

module.exports = { sendDiscordNotification };
