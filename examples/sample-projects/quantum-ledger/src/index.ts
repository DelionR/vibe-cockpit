import express from 'express';
import { postTransfer } from './utils.js';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/transfer', (req, res) => {
  const result = postTransfer(req.body);
  res.json(result);
});

app.listen(8080, () => console.log('quantum-ledger on :8080'));
