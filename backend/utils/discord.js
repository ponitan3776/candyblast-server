async function sendDiscordNotification(webhookUrl, title, description, color = 0x5865F2, fields = []) {
  if (!webhookUrl) return;
  try {
    const payload = {
      embeds: [{
        title, description, color,
        timestamp: new Date().toISOString(),
        fields,
        footer: { text: 'CandyBlast Auth System' }
      }]
    };
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Discord通知失敗:', err.message);
  }
}

module.exports = { sendDiscordNotification };
