/**
 * routes.js — Orders HTTP Endpoints
 */

'use strict';

const express = require('express');
const OrderService = require('./order_service');

function createOrderRouter(db) {
  const router = express.Router();
  const service = new OrderService(db);

  const getBizId = (req) => {
    if (req.user && req.user.businessId) return req.user.businessId;
    return parseInt(req.query.business_id || req.body.business_id || 1, 10);
  };

  /** GET /api/orders */
  router.get('/', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { type, status, contact_id, limit } = req.query;
      const orders = service.listOrders({
        businessId: bizId,
        type: type ? String(type).toUpperCase() : null,
        status: status ? String(status).toUpperCase() : null,
        contactId: contact_id ? parseInt(contact_id, 10) : null,
        limit: limit ? parseInt(limit, 10) : 50
      });
      res.json(orders);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/orders/:id */
  router.get('/:id', (req, res) => {
    try {
      const bizId = getBizId(req);
      const order = service.getOrderById(parseInt(req.params.id, 10), bizId);
      if (!order) {
        return res.status(404).json({ error: true, message: 'Order not found', code: 'NOT_FOUND' });
      }
      res.json(order);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/orders */
  router.post('/', (req, res) => {
    try {
      const bizId = getBizId(req);
      const contactId = req.body.contact_id || req.body.contactId;
      const orderNumber = req.body.order_number || req.body.orderNumber;
      const rawDueDate = req.body.due_date || req.body.dueDate;
      const allowBackorder = req.body.allow_backorder !== undefined ? req.body.allow_backorder : req.body.allowBackorder;
      const type = req.body.type;
      const notes = req.body.notes;
      const lines = req.body.lines;

      if (!contactId) {
        return res.status(400).json({ error: true, message: 'Please select a valid customer or supplier contact', code: 'VALIDATION_ERROR' });
      }

      if (!lines || !Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ error: true, message: 'Order must contain at least one line item with a quantity', code: 'VALIDATION_ERROR' });
      }

      let dueDate = rawDueDate;
      if (dueDate && /^\d{2}-\d{2}-\d{4}$/.test(dueDate)) {
        const [d, m, y] = dueDate.split('-');
        dueDate = `${y}-${m}-${d}`;
      } else if (!dueDate) {
        dueDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      }

      const created = service.createOrder({
        businessId: bizId,
        contactId: parseInt(contactId, 10),
        orderNumber: orderNumber,
        type,
        dueDate,
        notes: notes || '',
        allowBackorder: Boolean(allowBackorder),
        lines
      });

      res.status(201).json(created);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR' || err.code === 'INVALID_ORDER_TYPE' || err.code === 'INVALID_LINE_QUANTITY' || err.code === 'INSUFFICIENT_STOCK') {
        return res.status(400).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'CONTACT_NOT_FOUND' || err.code === 'PRODUCT_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code || 'BAD_REQUEST' });
    }
  });

  /** POST /api/orders/:id/confirm */
  router.post('/:id/confirm', (req, res) => {
    try {
      const bizId = getBizId(req);
      const confirmed = service.confirmOrder(parseInt(req.params.id, 10), bizId);
      res.json(confirmed);
    } catch (err) {
      if (err.code === 'INSUFFICIENT_STOCK') {
        return res.status(422).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/orders/:id/fulfill */
  router.post('/:id/fulfill', (req, res) => {
    try {
      const bizId = getBizId(req);
      const locationId = req.body.location_id ? parseInt(req.body.location_id, 10) : null;
      const fulfilled = service.fulfillOrder(parseInt(req.params.id, 10), bizId, locationId);
      res.json(fulfilled);
    } catch (err) {
      if (err.code === 'INSUFFICIENT_STOCK') {
        return res.status(422).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/orders/:id/receive (Partial / Full PO Receiving) */
  router.post('/:id/receive', (req, res) => {
    try {
      const bizId = getBizId(req);
      const orderId = parseInt(req.params.id, 10);
      const { location_id, items } = req.body;
      const received = service.receivePurchaseOrder({
        orderId,
        businessId: bizId,
        locationId: location_id ? parseInt(location_id, 10) : null,
        items: Array.isArray(items) ? items : [],
        userId: req.user?.id || null
      });
      res.json(received);
    } catch (err) {
      if (err.code === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/orders/:id/fulfill-partial (Partial Sales Order Dispatch) */
  router.post('/:id/fulfill-partial', (req, res) => {
    try {
      const bizId = getBizId(req);
      const orderId = parseInt(req.params.id, 10);
      const { location_id, items } = req.body;
      const fulfilled = service.fulfillSalesOrder({
        orderId,
        businessId: bizId,
        locationId: location_id ? parseInt(location_id, 10) : null,
        items: Array.isArray(items) ? items : [],
        userId: req.user?.id || null
      });
      res.json(fulfilled);
    } catch (err) {
      if (err.code === 'INSUFFICIENT_STOCK') {
        return res.status(422).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/orders/:id/cancel */
  router.post('/:id/cancel', (req, res) => {
    try {
      const bizId = getBizId(req);
      const cancelled = service.cancelOrder(parseInt(req.params.id, 10), bizId);
      res.json(cancelled);
    } catch (err) {
      if (err.code === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/orders/:id/unconfirm (Revert Confirmed Order to Draft) */
  router.post('/:id/unconfirm', (req, res) => {
    try {
      const bizId = getBizId(req);
      const reverted = service.unconfirmOrder(parseInt(req.params.id, 10), bizId);
      res.json(reverted);
    } catch (err) {
      if (err.code === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/orders/:id/void-and-revert (Atomic Void of Payments, Receipts, and Fulfillment) */
  router.post('/:id/void-and-revert', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { reason } = req.body;
      const reverted = service.voidAndRevertOrder({
        orderId: parseInt(req.params.id, 10),
        businessId: bizId,
        reason: reason || 'User requested order void and reset to draft'
      });
      res.json(reverted);
    } catch (err) {
      if (err.code === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  return router;
}

module.exports = createOrderRouter;
