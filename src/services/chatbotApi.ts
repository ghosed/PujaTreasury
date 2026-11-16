import { ChatApiRequest, ChatApiResponse } from '../types/chatbot';

export async function sendChatQuery(payload: ChatApiRequest): Promise<ChatApiResponse> {
  const res = await fetch('/api/chat/message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg =
      typeof data?.error === 'string' && data.error.trim()
        ? data.error
        : `Chat request failed (${res.status})`;
    throw new Error(errMsg);
  }

  return data as ChatApiResponse;
}
