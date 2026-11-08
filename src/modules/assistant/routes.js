/**
 * routes.js — Assistant & Copilot API Endpoints
 *
 * Exposes:
 * - GET /api/assistant/context (live snapshot of tenant context)
 * - POST /api/assistant/ask (deterministic RAG & grounded factual answering)
 */

'use strict';

const express = require('express');
const AssistantService = require('./assistant_service');

function createAssistantRouter(db) {
  const router = express.Router();
  const service = new AssistantService(db);

  const getBizId = (req) => {
    if (req.user && req.user.businessId) return req.user.businessId;
    return parseInt(req.query.business_id || req.body?.business_id || 1, 10);
  };

  /**
   * GET /api/assistant/context
   * Returns live tenant-isolated business snapshot
   */
  router.get('/context', (req, res) => {
    try {
      const bizId = getBizId(req);
      const context = service.getContext(bizId);
      res.json({
        success: true,
        businessId: bizId,
        ...context
      });
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  /**
   * POST /api/assistant/ask
   * Body: { question, history }
   * Returns grounded answer with live database context
   */
  router.post('/ask', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { question, history, mode } = req.body;

      if (!question || !question.trim()) {
        return res.status(400).json({ error: true, message: 'Question prompt is required' });
      }

      const result = service.ask({
        businessId: bizId,
        question: question.trim(),
        mode: mode || 'ledger',
        history: history || []
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message });
    }
  });

  return router;
}

module.exports = createAssistantRouter;
