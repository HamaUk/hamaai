const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/** Stream a live generation from the project backend. */
export async function* streamChat({ messages, model, mode = 'smart', search = false, signal }) {
  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model, mode, search, stream: true }),
    signal
  });

  if (!response.ok) {
    const raw = await response.text();
    let message = raw || `Generation failed (${response.status})`;
    try { message = JSON.parse(raw).error || message; } catch { /* plain text */ }
    throw new Error(message);
  }
  if (!response.body) throw new Error('The generation stream was empty.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}
