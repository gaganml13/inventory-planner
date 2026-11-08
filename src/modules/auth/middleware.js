/**
 * middleware.js — Authentication and Tenant Scoping Middleware
 */

'use strict';

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx !== -1) {
      const key = pair.substring(0, idx).trim();
      const val = pair.substring(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

function createAuthMiddleware(authService) {
  function authenticate(req, res, next) {
    // 1. Check Cookie
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies.session;

    // 2. Check Authorization Header as fallback
    if (!token && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
      }
    }

    if (!token) {
      req.user = null;
      req.business = null;
      return next();
    }

    try {
      const sessionData = authService.validateSession(token);
      if (sessionData) {
        req.user = sessionData.user;
        req.business = sessionData.business;
        req.user.businessId = sessionData.business.id;
        req.sessionId = sessionData.sessionId;
      } else {
        req.user = null;
        req.business = null;
      }
    } catch (err) {
      req.user = null;
      req.business = null;
    }

    next();
  }

  function requireAuth(req, res, next) {
    if (req.user && req.business) {
      return next();
    }

    const isApi = req.originalUrl.startsWith('/api/') || 
      (req.headers.accept && req.headers.accept.includes('application/json'));

    if (isApi) {
      return res.status(401).json({
        error: true,
        code: 'UNAUTHENTICATED',
        message: 'Authentication required. Please sign in or explore demo mode.'
      });
    }

    return res.redirect('/login');
  }

  function requireRole(...allowedRoles) {
    return (req, res, next) => {
      if (!req.user || !req.business) {
        return res.status(401).json({
          error: true,
          code: 'UNAUTHENTICATED',
          message: 'Authentication required. Please sign in or explore demo mode.'
        });
      }
      const userRole = req.user.role || 'OWNER';
      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({
          error: true,
          code: 'FORBIDDEN',
          message: `Access denied. Role '${userRole}' does not have permission for this action. Required role: ${allowedRoles.join(' or ')}.`
        });
      }
      next();
    };
  }

  return {
    authenticate,
    requireAuth,
    requireRole,
    parseCookies
  };
}

module.exports = { createAuthMiddleware, parseCookies };
