// Утилиты форматирования ответов salebot.
export function formatReply(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'Пустое сообщение игнорируется.';
  const upper = trimmed.toUpperCase();
  return `Вы написали: ${trimmed} (${upper.length} символов)`;
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function timestamp() {
  return new Date().toISOString();
}
