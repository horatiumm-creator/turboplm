import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import authRouter from './routes/auth';
import partsRouter from './routes/parts';
import bomRouter from './routes/bom';
import processRouter from './routes/process';
import ecnsRouter from './routes/ecns';
import compareRouter from './routes/compare';
import documentsRouter from './routes/documents';
import ecrsRouter from './routes/ecrs';
import sourcingRouter from './routes/sourcing';
import attributesRouter from './routes/attributes';
import baselinesRouter from './routes/baselines';
import costRouter from './routes/cost';
import usersRouter from './routes/users';
import auditRouter from './routes/audit';
import notificationsRouter from './routes/notifications';
import searchRouter from './routes/search';
import myWorkRouter from './routes/mywork';
import emailRouter from './routes/email';
import requirementsRouter from './routes/requirements';
import workflowsRouter from './routes/workflows';
import integrationRouter from './routes/integration';
import erpRouter from './routes/erp';
import variantsRouter from './routes/variants';
import analyticsRouter from './routes/analytics';
import qualityRouter from './routes/quality';
import projectsRouter from './routes/projects';
import rfqRouter from './routes/rfq';
import { startEmailDispatcher } from './lib/mailer';
import { startWebhookDispatcher } from './lib/webhooks';
import statsRouter from './routes/stats';
import { requireAuth } from './middleware/auth';
import { apiKeyAuth } from './middleware/apikey';
import { requireWriteRole } from './middleware/rbac';
import { auditMiddleware } from './middleware/audit';
import { errorMiddleware } from './lib/errors';

const app = express();
app.use(cors({ origin: true, credentials: true }));
// Bulk ERP imports post whole CSV files in the JSON body, so the 100 KB
// body-parser default is far too small for a real item master.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/auth', authRouter);
// All other /api routes: X-API-Key machine auth (when present) or cookie
// session; VIEWERs read-only; mutations audited.
app.use('/api', apiKeyAuth, requireAuth, requireWriteRole, auditMiddleware);
app.use('/api', partsRouter);
app.use('/api', bomRouter);
app.use('/api', processRouter);
app.use('/api', ecnsRouter);
app.use('/api', compareRouter);
app.use('/api', documentsRouter);
app.use('/api', ecrsRouter);
app.use('/api', sourcingRouter);
app.use('/api', attributesRouter);
app.use('/api', baselinesRouter);
app.use('/api', costRouter);
app.use('/api', usersRouter);
app.use('/api', auditRouter);
app.use('/api', notificationsRouter);
app.use('/api', searchRouter);
app.use('/api', myWorkRouter);
app.use('/api', emailRouter);
app.use('/api', requirementsRouter);
app.use('/api', workflowsRouter);
app.use('/api', integrationRouter);
app.use('/api', erpRouter);
app.use('/api', variantsRouter);
app.use('/api', analyticsRouter);
app.use('/api', qualityRouter);
app.use('/api', projectsRouter);
app.use('/api', rfqRouter);
app.use('/api', statsRouter);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
app.use(errorMiddleware);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`TurboPLM API listening on :${port}`);
  startEmailDispatcher();
  startWebhookDispatcher();
});
