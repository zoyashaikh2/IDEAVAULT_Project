/**
 * Collect Groq API keys from env (primary + extras + comma-separated).
 * Order: GROQ_API_KEYS (csv), then GROQ_API_KEY (may be csv), then GROQ_API_KEY_2 through GROQ_API_KEY_5.
 */
function groqApiKeyList() {
  const chunks = [
    process.env.GROQ_API_KEYS,
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_API_KEY_5,
  ]
    .filter(Boolean)
    .join(',');
  const parts = chunks
    .split(',')
    .map((s) => String(s).trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

module.exports = { groqApiKeyList };
