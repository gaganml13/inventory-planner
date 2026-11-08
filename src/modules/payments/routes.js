/**
 * routes.js — Payments & Financial Intelligence Endpoints
 */

'use strict';

const express = require('express');
const PaymentService = require('./payment_service');

function createPaymentRouter(db) {
  const router = express.Router();
  const service = new PaymentService(db);

  const getBizId = (req) => {
    if (req.user && req.user.businessId) return req.user.businessId;
    return parseInt(req.query.business_id || req.body.business_id || 1, 10);
  };

  /** GET /api/payments/summary */
  router.get('/summary', (req, res) => {
    try {
      const bizId = getBizId(req);
      const summary = service.getFinancialSummary(bizId);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/payments */
  router.get('/', (req, res) => {
    try {
      const bizId = getBizId(req);
      const orderId = req.query.order_id ? parseInt(req.query.order_id, 10) : null;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
      const payments = service.listPayments({ businessId: bizId, orderId, limit });
      res.json(payments);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/payments */
  router.post('/', (req, res) => {
    try {
      const { order_id, amount_cents, payment_method, notes, recorded_at } = req.body;

      if (!order_id || amount_cents === undefined) {
        return res.status(400).json({
          error: true,
          message: 'order_id and amount_cents are required',
          code: 'VALIDATION_ERROR'
        });
      }

      const result = service.recordPayment({
        orderId: parseInt(order_id, 10),
        amountCents: parseInt(amount_cents, 10),
        paymentMethod: payment_method || 'BANK_TRANSFER',
        notes: notes || '',
        recordedAt: recorded_at || null
      });

      res.status(201).json(result);
    } catch (err) {
      if (err.code === 'OVER_ALLOCATION_ERROR' || err.code === 'INVALID_AMOUNT') {
        return res.status(422).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  return router;
}

module.exports = createPaymentRouter;
