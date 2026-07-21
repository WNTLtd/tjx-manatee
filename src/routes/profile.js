const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { requireAuth, setFlash } = require("../middleware/auth");
const { generateResetToken } = require("../utils/password");
const { sendSystemEmail, getAppBaseUrl } = require("../utils/mailer");
const { buildTwoFactorOtpAuthUrl, buildTwoFactorQrDataUrl, generateTwoFactorSecret, verifyTwoFactorToken } = require("../utils/twoFactor");

const router = express.Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  const user = db
    .prepare("SELECT id, role, email, title, pronouns, first_name, surname, job_title, phone, twofa_enabled, twofa_secret FROM users WHERE id = ?")
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

  const isAdmin = req.currentUser.role === "admin";

  return res.render("profile/index", {
    title: "Profile",
    user,
    pendingTwoFactorSetup,
    isAdmin,
  });
});

router.post("/details", (req, res) => {
  const title = String(req.body.title || "").trim() || null;
  const pronouns = String(req.body.pronouns || "").trim() || null;
  const firstName = String(req.body.first_name || "").trim() || null;
  const surname = String(req.body.surname || "").trim() || null;
  const jobTitle = String(req.body.job_title || "").trim() || null;
  const phone = String(req.body.phone || "").trim() || null;

  db.prepare(
    "UPDATE users SET title = ?, pronouns = ?, first_name = ?, surname = ?, job_title = ?, phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(title, pronouns, firstName, surname, jobTitle, phone, req.currentUser.id);

  setFlash(req, "success", "Personal details updated.");
  return res.redirect("/profile");
});

router.post("/role", (req, res) => {
  if (req.currentUser.role !== "admin") {
    setFlash(req, "error", "Only admins can change user roles.");
    return res.redirect("/profile");
  }

  const role = String(req.body.role || "").trim();
  const validRoles = ["admin", "mentor", "mentee", "both"];

  if (!validRoles.includes(role)) {
    setFlash(req, "error", "Invalid role.");
    return res.redirect("/profile");
  }

  db.prepare("UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(role, req.currentUser.id);

  setFlash(req, "success", "Role updated.");
  return res.redirect("/profile");
});

router.post("/email", async (req, res) => {
  const email = String(req.body.email || "").trim();
  const currentPassword = String(req.body.currentPassword || "");
  if (!email) {
    setFlash(req, "error", "Email is required.");
    return res.redirect("/profile");
  }

  const currentUser = db
    .prepare("SELECT id, email, password_hash FROM users WHERE id = ?")
    .get(req.currentUser.id);

  if (!currentUser || !bcrypt.compareSync(currentPassword, currentUser.password_hash)) {
    setFlash(req, "error", "Current password is incorrect.");
    return res.redirect("/profile");
  }

  if (currentUser.email === email) {
    setFlash(req, "error", "New email is the same as your current email.");
    return res.redirect("/profile");
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, req.currentUser.id);
  if (existing) {
    setFlash(req, "error", "Email already in use.");
    return res.redirect("/profile");
  }

  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  db.prepare("UPDATE email_change_recoveries SET used = 1 WHERE user_id = ? AND used = 0").run(req.currentUser.id);
  db.prepare("UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(email, req.currentUser.id);
  db.prepare(
    `INSERT INTO email_change_recoveries (user_id, old_email, new_email, token, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(req.currentUser.id, currentUser.email, email, token, expiresAt);

  const base = getAppBaseUrl();
  const recoverLink = `${base}/recover-email-change/${token}`;
  const expireText = "72 hours";

  const [newEmailResult, oldEmailResult] = await Promise.allSettled([
    sendSystemEmail({
      to: email,
      subject: "Your Manatee email address was changed",
      html: `<p>Your account email has been updated to this address.</p><p>If you did not make this change, contact support immediately.</p>`,
      text: "Your account email has been updated to this address. If you did not make this change, contact support immediately.",
      eventType: "profile_email_changed_new_address_notice",
      actorUserId: req.currentUser.id,
    }),
    sendSystemEmail({
      to: currentUser.email,
      subject: "Security alert: your Manatee email was changed",
      html: `<p>Your Manatee login email was changed from this address to <strong>${email}</strong>.</p><p>If this was not you, use this recovery link within ${expireText}:</p><p><a href="${recoverLink}">${recoverLink}</a></p>`,
      text: `Your Manatee login email was changed from this address to ${email}. If this was not you, use this recovery link within ${expireText}: ${recoverLink}`,
      eventType: "profile_email_changed_old_address_alert",
      actorUserId: req.currentUser.id,
    }),
  ]);

  if (newEmailResult.status === "rejected" || oldEmailResult.status === "rejected") {
    setFlash(req, "error", "Email updated, but one or more notification emails failed to send.");
    return res.redirect("/profile");
  }

  setFlash(req, "success", "Email updated. Confirmation and recovery emails have been sent.");
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
