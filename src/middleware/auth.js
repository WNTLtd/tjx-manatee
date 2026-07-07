const { db, getSiteSettings } = require("../db");

function attachAuthContext(req, res, next) {
  res.locals.theme = getSiteSettings();

  const userId = req.session.userId;
  if (!userId) {
    req.currentUser = null;
    res.locals.currentUser = null;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    return next();
  }

  const user = db
    .prepare("SELECT id, role, email FROM users WHERE id = ?")
    .get(userId);

  if (!user) {
    req.session.userId = null;
    req.currentUser = null;
    res.locals.currentUser = null;
    return next();
  }

  req.currentUser = user;
  res.locals.currentUser = user;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  return next();
}

function requireAuth(req, res, next) {
  if (!req.currentUser) return res.redirect("/login");
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.currentUser) return res.redirect("/login");

    const allowedRoles = {
      admin: ["admin"],
      mentor: ["mentor", "both"],
      mentee: ["mentee", "both"],
    };

    const accepted = allowedRoles[role] || [role];
    if (!accepted.includes(req.currentUser.role)) {
      req.session.flash = { type: "error", message: "Access denied." };
      return res.redirect("/");
    }
    return next();
  };
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = {
  attachAuthContext,
  requireAuth,
  requireRole,
  setFlash,
};
