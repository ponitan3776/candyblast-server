function generateRecoveryCode() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(Math.random().toString(36).slice(2, 6).toUpperCase());
  }
  return parts.join('-');
}

module.exports = { generateRecoveryCode };
