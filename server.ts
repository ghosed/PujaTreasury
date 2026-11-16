import 'dotenv/config';
import express from 'express';
import path from 'path';
import type { ChatApiRequest } from './src/types/chatbot.ts';
import { formatGeminiError, handleChatRequest } from './server/geminiChat.ts';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/chat/message', async (req, res) => {
    try {
      const body = req.body as Partial<ChatApiRequest> | undefined;
      if (!body || typeof body.message !== 'string' || !body.message.trim()) {
        res.status(400).json({ error: 'A non-empty message is required.' });
        return;
      }
      if (!body.snapshot || !Array.isArray(body.snapshot.expenses) || !Array.isArray(body.snapshot.bankTransactions)) {
        res.status(400).json({ error: 'Valid ledger snapshot data is required.' });
        return;
      }

      const result = await handleChatRequest({
        message: body.message.trim(),
        history: Array.isArray(body.history) ? body.history : [],
        snapshot: body.snapshot,
      });

      res.json(result);
    } catch (err) {
      const { status, message } = formatGeminiError(err);
      res.status(status).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LedgerSync server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start LedgerSync server:', err);
  process.exit(1);
});
