/**
 * routes.js — Contacts HTTP Endpoints
 */

'use strict';

const express = require('express');
const ContactService = require('./contact_service');

function createContactRouter(db) {
  const router = express.Router();
  const service = new ContactService(db);

  const getBizId = (req) => {
    if (req.user && req.user.businessId) return req.user.businessId;
    return parseInt(req.query.business_id || req.body.business_id || 1, 10);
  };

  /** GET /api/contacts */
  router.get('/', (req, res) => {
    try {
      const bizId = getBizId(req);
      const type = req.query.type ? String(req.query.type).toUpperCase() : null;
      const contacts = service.listContacts({ businessId: bizId, type });
      res.json(contacts);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** GET /api/contacts/:id */
  router.get('/:id', (req, res) => {
    try {
      const contact = service.getContactById(parseInt(req.params.id, 10));
      if (!contact) {
        return res.status(404).json({ error: true, message: 'Contact not found', code: 'NOT_FOUND' });
      }
      res.json(contact);
    } catch (err) {
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** POST /api/contacts */
  router.post('/', (req, res) => {
    try {
      const bizId = getBizId(req);
      const { type, name, email, phone, credit_limit_cents, payment_terms_days } = req.body;

      const created = service.createContact({
        businessId: bizId,
        type,
        name,
        email,
        phone,
        creditLimitCents: credit_limit_cents,
        paymentTermsDays: payment_terms_days
      });

      res.status(201).json(created);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR' || err.code === 'INVALID_CONTACT_TYPE') {
        return res.status(400).json({ error: true, message: err.message, code: err.code });
      }
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** PUT /api/contacts/:id */
  router.put('/:id', (req, res) => {
    try {
      const bizId = getBizId(req);
      const contactId = parseInt(req.params.id, 10);
      const updated = service.updateContact({
        contactId,
        businessId: bizId,
        type: req.body.type,
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone,
        creditLimitCents: req.body.credit_limit_cents,
        paymentTermsDays: req.body.payment_terms_days
      });
      res.json(updated);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      res.status(400).json({ error: true, message: err.message, code: err.code });
    }
  });

  /** DELETE /api/contacts/:id */
  router.delete('/:id', (req, res) => {
    try {
      const bizId = getBizId(req);
      const contactId = parseInt(req.params.id, 10);
      const result = service.deleteContact(contactId, bizId);
      res.json(result);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: true, message: err.message, code: err.code });
      }
      if (err.code === 'CONTACT_IN_USE') {
        return res.status(409).json({ error: true, message: err.message, code: err.code });
      }
      res.status(500).json({ error: true, message: err.message, code: err.code });
    }
  });

  return router;
}

module.exports = createContactRouter;
