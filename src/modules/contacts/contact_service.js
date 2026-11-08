/**
 * contact_service.js — Customers and Suppliers with Credit Limits & Terms
 */

'use strict';

const { getDb } = require('../../../database/connection');

class ContactService {
  constructor(customDb) {
    this.db = customDb || getDb();
  }

  listContacts({ businessId, type = null }) {
    let sql = `
      SELECT 
        c.*,
        COALESCE(sales.open_ar_cents, 0) AS open_ar_cents,
        COALESCE(purch.open_ap_cents, 0) AS open_ap_cents
      FROM contacts c
      
      -- Open customer balance
      LEFT JOIN (
        SELECT contact_id, SUM(total_cents - paid_cents) AS open_ar_cents
        FROM orders
        WHERE business_id = ? AND type = 'SALE' AND status != 'CANCELLED' AND paid_cents < total_cents
        GROUP BY contact_id
      ) sales ON c.id = sales.contact_id

      -- Open supplier balance
      LEFT JOIN (
        SELECT contact_id, SUM(total_cents - paid_cents) AS open_ap_cents
        FROM orders
        WHERE business_id = ? AND type = 'PURCHASE' AND status != 'CANCELLED' AND paid_cents < total_cents
        GROUP BY contact_id
      ) purch ON c.id = purch.contact_id

      WHERE c.business_id = ?
    `;
    const params = [businessId, businessId, businessId];

    if (type) {
      sql += ' AND c.type = ?';
      params.push(type.toUpperCase());
    }

    sql += ' ORDER BY c.name ASC';
    return this.db.prepare(sql).all(...params);
  }

  getContactById(contactId) {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  }

  createContact({ businessId, type, name, email = '', phone = '', creditLimitCents = 0, paymentTermsDays = 30 }) {
    const contactType = String(type).toUpperCase();
    if (!['CUSTOMER', 'SUPPLIER'].includes(contactType)) {
      const err = new Error("Contact type must be 'CUSTOMER' or 'SUPPLIER'");
      err.code = 'INVALID_CONTACT_TYPE';
      throw err;
    }

    if (!name || !name.trim()) {
      const err = new Error('Contact name is required');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const res = this.db.prepare(`
      INSERT INTO contacts (
        business_id, type, name, email, phone, credit_limit_cents, payment_terms_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      businessId,
      contactType,
      name.trim(),
      email ? email.trim() : '',
      phone ? phone.trim() : '',
      Math.max(0, parseInt(creditLimitCents, 10) || 0),
      Math.max(0, parseInt(paymentTermsDays, 10) || 30)
    );

    return this.getContactById(res.lastInsertRowid);
  }

  updateContact({ contactId, businessId, type, name, email, phone, creditLimitCents, paymentTermsDays }) {
    const existing = this.db.prepare('SELECT * FROM contacts WHERE id = ? AND business_id = ?').get(contactId, businessId);
    if (!existing) {
      const err = new Error(`Contact #${contactId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    const updatedType = type ? String(type).toUpperCase() : existing.type;
    const updatedName = name ? name.trim() : existing.name;
    const updatedEmail = email !== undefined ? email.trim() : existing.email;
    const updatedPhone = phone !== undefined ? phone.trim() : existing.phone;
    const updatedCredit = creditLimitCents !== undefined ? Math.max(0, parseInt(creditLimitCents, 10) || 0) : existing.credit_limit_cents;
    const updatedTerms = paymentTermsDays !== undefined ? Math.max(0, parseInt(paymentTermsDays, 10) || 0) : existing.payment_terms_days;

    this.db.prepare(`
      UPDATE contacts
      SET type = ?, name = ?, email = ?, phone = ?, credit_limit_cents = ?, payment_terms_days = ?
      WHERE id = ? AND business_id = ?
    `).run(
      updatedType,
      updatedName,
      updatedEmail,
      updatedPhone,
      updatedCredit,
      updatedTerms,
      contactId,
      businessId
    );

    return this.getContactById(contactId);
  }

  deleteContact(contactId, businessId) {
    const existing = this.db.prepare('SELECT * FROM contacts WHERE id = ? AND business_id = ?').get(contactId, businessId);
    if (!existing) {
      const err = new Error(`Contact #${contactId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Check open orders
    const activeOrder = this.db.prepare(`
      SELECT order_number, status FROM orders 
      WHERE contact_id = ? AND business_id = ? AND status IN ('CONFIRMED', 'DRAFT')
      LIMIT 1
    `).get(contactId, businessId);

    if (activeOrder) {
      const err = new Error(`Cannot delete contact ${existing.name} because active order ${activeOrder.order_number} is open`);
      err.code = 'CONTACT_IN_USE';
      throw err;
    }

    this.db.prepare('DELETE FROM contacts WHERE id = ? AND business_id = ?').run(contactId, businessId);
    return { success: true, deletedContactId: contactId };
  }
}

module.exports = ContactService;
