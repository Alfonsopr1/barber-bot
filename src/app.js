const express = require('express');
const { verifyWebhook, receiveWebhook } = require('./bot/webhookHandler');
const healthRouter = require('./api/health');

const app = express();

app.use(
  express.json({
    verify: (req, res, buf) => {
      // Needed to check X-Hub-Signature-256 against the exact bytes Meta sent.
      req.rawBody = buf;
    },
  })
);

app.get('/webhook', verifyWebhook);
app.post('/webhook', receiveWebhook);
app.use('/health', healthRouter);

module.exports = app;
