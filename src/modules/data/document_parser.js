/**
 * document_parser.js — Document & Text Parser for Products Catalog (PDF & CSV)
 */

'use strict';

const zlib = require('zlib');

function extractTextFromPdfBuffer(buffer) {
  const textChunks = [];
  const content = buffer.toString('binary');

  // Match stream ... endstream blocks
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRegex.exec(content)) !== null) {
    const rawStream = Buffer.from(match[1], 'binary');
    let decompressed = null;
    try {
      decompressed = zlib.inflateSync(rawStream).toString('utf-8');
    } catch (_) {
      try {
        decompressed = zlib.inflateRawSync(rawStream).toString('utf-8');
      } catch (__) {
        decompressed = rawStream.toString('utf-8');
      }
    }

    if (decompressed) {
      // Look for text operators: (Text) Tj or [(T)(e)(x)(t)] TJ
      const tjRegex = /\((.*?)\)\s*Tj/g;
      let tjMatch;
      while ((tjMatch = tjRegex.exec(decompressed)) !== null) {
        if (tjMatch[1] && tjMatch[1].trim()) {
          textChunks.push(tjMatch[1]);
        }
      }
      const arrayRegex = /\[(.*?)\]\s*TJ/g;
      let arrMatch;
      while ((arrMatch = arrayRegex.exec(decompressed)) !== null) {
        const inner = arrMatch[1].replace(/\((.*?)\)/g, '$1 ');
        if (inner && inner.trim()) {
          textChunks.push(inner);
        }
      }
    }
  }

  // Fallback: If no Tj/TJ streams found, search for plain text chunks
  if (textChunks.length === 0) {
    const textPattern = /BT\s+([\s\S]*?)\s+ET/g;
    let btMatch;
    while ((btMatch = textPattern.exec(content)) !== null) {
      const inner = btMatch[1].replace(/[()]/g, ' ').trim();
      if (inner) textChunks.push(inner);
    }
  }

  return textChunks.join('\n');
}

function parseLinesToProducts(lines) {
  const products = [];
  const seenSkus = new Set();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.length < 3) continue;

    // Skip headers
    if (/^(sku|product|item|description|page|total|invoice|catalog|code|name|unit\s*price|subtotal|sl\s*no)/i.test(rawLine)) {
      continue;
    }

    // 1. Delimited: CSV, TSV, pipe, or semicolon
    if (rawLine.includes(',') || rawLine.includes('\t') || rawLine.includes('|') || rawLine.includes(';')) {
      const delim = rawLine.includes('\t') ? '\t' : (rawLine.includes('|') ? '|' : (rawLine.includes(';') ? ';' : ','));
      const parts = rawLine.split(delim).map((s) => s.trim().replace(/^["']|["']$/g, ''));
      if (parts.length >= 2 && parts[0].length >= 2) {
        const sku = parts[0].replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
        if (sku.length >= 2 && !seenSkus.has(sku)) {
          seenSkus.add(sku);
          const cost = parseFloat(parts[3]) || 0;
          const sell = parseFloat(parts[4]) || (cost > 0 ? +(cost * 1.5).toFixed(2) : 0);
          products.push({
            sku,
            barcode: parts[1] && parts[1].length > 4 && /^\d+$/.test(parts[1]) ? parts[1] : sku,
            name: parts[1] && !/^\d+$/.test(parts[1]) ? parts[1] : (parts[2] || sku),
            category: parts[2] && isNaN(parseFloat(parts[2])) ? parts[2] : 'Catalog_Import',
            pack_size: parseInt(parts[5], 10) || 1,
            cost_price: cost || 10.0,
            sell_price: sell || 19.99,
            initial_stock: parseInt(parts[6] || parts[5] || 0, 10) || 0,
            lead_days: 7,
            min_safety_stock: 5
          });
          continue;
        }
      }
    }

    // 2. Space-separated or columnar formatted
    const tokens = rawLine.split(/\s+/).filter(Boolean);
    if (tokens.length >= 3) {
      const skuCandidate = tokens[0].replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
      if (skuCandidate.length >= 3 && /^[A-Z0-9]/.test(skuCandidate) && !seenSkus.has(skuCandidate)) {
        const prices = [];
        const words = [];
        let category = 'Catalog_Import';
        let stock = 0;

        for (let j = 1; j < tokens.length; j++) {
          const tok = tokens[j].replace(/[$,]/g, '');
          const num = parseFloat(tok);
          if (!isNaN(num) && /^\d+(\.\d{1,2})?$/.test(tok)) {
            prices.push(num);
          } else {
            words.push(tokens[j]);
          }
        }

        if (words.length > 0 || prices.length > 0) {
          seenSkus.add(skuCandidate);
          const cost = prices[0] || 10.0;
          const sell = prices[1] || (prices[0] ? +(prices[0] * 1.6).toFixed(2) : 25.0);
          if (prices.length > 2 && Number.isInteger(prices[2])) {
            stock = parseInt(prices[2], 10);
          }
          products.push({
            sku: skuCandidate,
            barcode: skuCandidate,
            name: words.join(' ') || `Product ${skuCandidate}`,
            category,
            pack_size: 1,
            cost_price: cost,
            sell_price: sell,
            initial_stock: stock,
            lead_days: 7,
            min_safety_stock: 5
          });
        }
      }
    }
  }

  return products;
}

module.exports = {
  extractTextFromPdfBuffer,
  parseLinesToProducts
};
