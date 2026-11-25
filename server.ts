import 'dotenv/config';
import express from 'express';
import path from 'path';
import type { ChatApiRequest } from './src/types/chatbot.ts';
import type { CheckCategorizeRequest } from './src/types/check.ts';
import type { AmazonCategorizeRequest } from './src/types/amazon.ts';
import { formatGeminiError, handleChatRequest } from './server/geminiChat.ts';
import { type CheckScanRequest, scanCheckDocument } from './server/checkScanner.ts';
import { categorizeChecksWithGemini } from './server/checkCategorizer.ts';
import { type AmazonScanRequest, scanAmazonDocument } from './server/amazonScanner.ts';
import { categorizeAmazonWithGemini } from './server/amazonCategorizer.ts';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));

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

  app.post('/api/checks/scan', async (req, res) => {
    try {
      const body = req.body as Partial<CheckScanRequest> | undefined;
      if (!body || typeof body.base64Data !== 'string' || !body.base64Data.trim()) {
        res.status(400).json({ error: 'Check image or PDF file content is required.' });
        return;
      }

      const result = await scanCheckDocument({
        fileName: typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim() : 'check-upload',
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : '',
        base64Data: body.base64Data,
      });

      res.json(result);
    } catch (err) {
      const { status, message } = formatGeminiError(err);
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/checks/categorize', async (req, res) => {
    try {
      const body = req.body as Partial<CheckCategorizeRequest> | undefined;
      if (!body || !Array.isArray(body.checks)) {
        res.status(400).json({ error: 'An array of checks to categorize is required.' });
        return;
      }

      const result = await categorizeChecksWithGemini({
        checks: body.checks,
        expenseCategories: Array.isArray(body.expenseCategories)
          ? body.expenseCategories
          : [],
        incomeCategories: Array.isArray(body.incomeCategories) ? body.incomeCategories : [],
        historicalExamples: Array.isArray(body.historicalExamples)
          ? body.historicalExamples
          : [],
      });

      res.json(result);
    } catch (err) {
      const { status, message } = formatGeminiError(err);
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/amazon/scan', async (req, res) => {
    try {
      const body = req.body as Partial<AmazonScanRequest> | undefined;
      if (!body || typeof body.base64Data !== 'string' || !body.base64Data.trim()) {
        res.status(400).json({ error: 'Amazon order image or PDF file content is required.' });
        return;
      }

      const result = await scanAmazonDocument({
        fileName:
          typeof body.fileName === 'string' && body.fileName.trim()
            ? body.fileName.trim()
            : 'amazon-order-upload',
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : '',
        base64Data: body.base64Data,
      });

      res.json(result);
    } catch (err) {
      const { status, message } = formatGeminiError(err);
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/amazon/categorize', async (req, res) => {
    try {
      const body = req.body as Partial<AmazonCategorizeRequest> | undefined;
      if (!body || !Array.isArray(body.items)) {
        res.status(400).json({ error: 'An array of Amazon order items to categorize is required.' });
        return;
      }

      const result = await categorizeAmazonWithGemini({
        items: body.items,
        expenseCategories: Array.isArray(body.expenseCategories)
          ? body.expenseCategories
          : [],
        historicalExamples: Array.isArray(body.historicalExamples)
          ? body.historicalExamples
          : [],
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
