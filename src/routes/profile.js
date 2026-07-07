const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { requireAuth, setFlash } = require("../middleware/auth");
const { buildTwoFactorOtpAuthUrl, buildTwoFactorQrDataUrl, generateTwoFactorSecret, verifyTwoFactorToken } = require("../utils/twoFactor");

const router = express.Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  const user = db
    .prepare("SELECT id, role, email, title, pronouns, first_name, surname, job_title, twofa_enabled, twofa_secret FROM users WHERE id = ?")
    .get(req.currentUser.id);

  let pendingTwoFactorSetup = null;
  const pendingSecret = String(req.session.pendingTwoFactorSetupSecret || "").trim();
  if (pendingSecret) {
    const otpAuthUrl = buildTwoFactorOtpAuthUrl(user.email, pendingSecret);
    let qrCodeDataUrl = null;
    try {
      qrCodeDataUrl = await buildTwoFactorQrDataUrl(user.email, pendingSecret);
    } catch (err) {
      console.error("Failed to build 2FA QR code", err);
    }

    pendingTwoFactorSetup = {
      secret: pendingSecret,
      otpAuthUrl,
      qrCodeDataUrl,
    };
  }

  return res.render("profile/index", {
    title: "Profile",
    user,
    pendingTwoFactorSetup,
  });
});

router.post("/details", (req, res) => {
  const title = String(req.body.title || "").trim() || null;
  const pronouns = String(req.body.pronouns || "").trim() || null;
  const firstName = String(req.body.first_name || "").trim() || null;
  const surname = String(req.body.surname || "").trim() || null;
  const jobTitle = String(req.body.job_title || "").trim() || null;

  db.prepare(
    "UPDATE users SET title = ?, pronouns = ?, first_name = ?, surname = ?, job_title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(title, pronouns, firstName, surname, jobTitle, req.currentUser.id);

  setFlash(req, "success", "Personal details updated.");
  return res.redirect("/profile");
});

router.post("/email", (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!email) {
    setFlash(req, "error", "Email is required.");
    return res.redirect("/profile");
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, req.currentUser.id);
  if (existing) {
    setFlash(req, "error", "Email already in use.");
    return res.redirect("/profile");
  }

  db.prepare("UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(email, req.currentUser.id);
  setFlash(req, "success", "Email updated.");
  return res.redirect("/profile");
});

router.post("/password", (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");

  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.currentUser.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    setFlash(req, "error", "Current password is incorrect.");
    return res.redirect("/profile");
  }

  if (newPassword.length < 6) {
    setFlash(req, "error", "New password must be at least 6 characters.");
    return res.redirect("/profile");
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(hash, req.currentUser.id);

  setFlash(req, "success", "Password updated.");
  return res.redirect("/profile");
});

router.post("/2fa/setup", (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const user = db.prepare("SELECT password_hash, twofa_enabled FROM users WHERE id = ?").get(req.currentUser.id);

  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    setFlash(req, "error", "Current password is incorrect.");
    return res.redirect("/profile");
  }

  if (Number(user.twofa_enabled) === 1) {
    setFlash(req, "error", "Two-factor authentication is already enabled.");
    return res.redirect("/profile");
  }

  req.session.pendingTwoFactorSetupSecret = generateTwoFactorSecret();
  setFlash(req, "success", "Scan the QR code and enter a code to enable 2FA.");
  return res.redirect("/profile");
});

router.post("/2fa/enable", (req, res) => {
  const pendingSecret = String(req.session.pendingTwoFactorSetupSecret || "").trim();
  if (!pendingSecret) {
    setFlash(req, "error", "Start 2FA setup first.");
    return res.redirect("/profile");
  }

  const token = String(req.body.token || "");
  if (!verifyTwoFactorToken(pendingSecret, token)) {
    setFlash(req, "error", "Invalid authenticator code.");
    return res.redirect("/profile");
  }

  db.prepare("UPDATE users SET twofa_enabled = 1, twofa_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    pendingSecret,
    req.currentUser.id
  );

  delete req.session.pendingTwoFactorSetupSecret;
  setFlash(req, "success", "Two-factor authentication enabled.");
  return res.redirect("/profile");
});

router.post("/2fa/cancel", (req, res) => {
  delete req.session.pendingTwoFactorSetupSecret;
  setFlash(req, "success", "Two-factor setup cancelled.");
  return res.redirect("/profile");
});

router.post("/2fa/disable", (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const token = String(req.body.token || "");

  const user = db
    .prepare("SELECT password_hash, twofa_enabled, twofa_secret FROM users WHERE id = ?")
    .get(req.currentUser.id);

  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    setFlash(req, "error", "Current password is incorrect.");
    return res.redirect("/profile");
  }

  if (Number(user.twofa_enabled) !== 1 || !user.twofa_secret) {
    setFlash(req, "error", "Two-factor authentication is not enabled.");
    return res.redirect("/profile");
  }

  if (!verifyTwoFactorToken(user.twofa_secret, token)) {
    setFlash(req, "error", "Invalid authenticator code.");
    return res.redirect("/profile");
  }

  db.prepare("UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.currentUser.id);
  delete req.session.pendingTwoFactorSetupSecret;
  setFlash(req, "success", "Two-factor authentication disabled.");
  return res.redirect("/profile");
});

module.exports = router;
