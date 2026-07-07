const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { setFlash, requireAuth } = require("../middleware/auth");
const { generateResetToken } = require("../utils/password");
const { sendSystemEmail } = require("../utils/mailer");

const router = express.Router();

const REGISTRATION_ROLES = ["mentor", "mentee", "both"];

router.get("/login", (req, res) => {
  if (req.currentUser) return res.redirect("/");
  return res.render("auth/login", { title: "Login" });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim());

  if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    setFlash(req, "error", "Invalid login credentials.");
    return res.redirect("/login");
  }

  req.session.userId = user.id;
  return req.session.save((err) => {
    if (err) {
      console.error("Session save failed on login", err);
      return res.status(500).render("error", {
        title: "Login Error",
        message: "Unable to complete login right now. Please try again.",
      });
    }

    setFlash(req, "success", "Welcome back.");
    return res.redirect("/");
  });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

router.get("/register", (req, res) => {
  if (req.currentUser) return res.redirect("/");
  return res.render("auth/register-role", { title: "Choose Role" });
});

router.post("/register", (req, res) => {
  const role = String(req.body.role || "");
  if (!REGISTRATION_ROLES.includes(role)) {
    setFlash(req, "error", "Please select a valid role.");
    return res.redirect("/register");
  }
  return res.redirect(`/register/${role}`);
});

router.get("/register/:role", (req, res) => {
  const role = req.params.role;
  if (!REGISTRATION_ROLES.includes(role)) return res.status(404).render("error", { title: "Not Found", message: "Page not found." });
  if (req.currentUser) return res.redirect("/");
  return res.render("auth/register", { title: "Register", role });
});

router.post("/register/:role", (req, res) => {
  const role = req.params.role;
  if (!REGISTRATION_ROLES.includes(role)) return res.status(404).render("error", { title: "Not Found", message: "Page not found." });

  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "").trim();

  if (!email || !password) {
    setFlash(req, "error", "Email and password are required.");
    return res.redirect(`/register/${role}`);
  }

  if (password.length < 6) {
    setFlash(req, "error", "Password must be at least 6 characters.");
    return res.redirect(`/register/${role}`);
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    setFlash(req, "error", "This email is already in use.");
    return res.redirect(`/register/${role}`);
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const createUser = db.transaction((userRole, userEmail, userHash) => {
      const insert = db
        .prepare("INSERT INTO users (role, email, password_hash) VALUES (?, ?, ?)")
        .run(userRole, userEmail, userHash);

      if (["mentor", "both"].includes(userRole)) {
        db.prepare("INSERT INTO mentor_profiles (user_id, available) VALUES (?, 1)").run(insert.lastInsertRowid);
      }
      if (["mentee", "both"].includes(userRole)) {
        db.prepare("INSERT INTO mentee_profiles (user_id) VALUES (?)").run(insert.lastInsertRowid);
      }

      return Number(insert.lastInsertRowid);
    });

    const userId = createUser(role, email, hash);
    req.session.userId = userId;

    return req.session.save((err) => {
      if (err) {
        console.error("Session save failed on registration", err);
        return res.status(500).render("error", {
          title: "Registration Error",
          message: "Account was created but auto-login failed. Please log in manually.",
        });
      }

      setFlash(req, "success", "Account created. Complete your profile.");
      return res.redirect(["mentor", "both"].includes(role) ? "/mentor/profile-setup" : "/mentee/profile-setup");
    });
  } catch (err) {
    console.error("Registration failed", err);
    setFlash(req, "error", "Registration failed. Please try again.");
    return res.redirect(`/register/${role}`);
  }
});

router.get("/forgot-password", (req, res) => {
  if (req.currentUser) return res.redirect("/");
  return res.render("auth/forgot-password", { title: "Forgot Password" });
});

router.post("/forgot-password", async (req, res) => {
  const email = String(req.body.email || "").trim();
  const user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);

  if (user) {
    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)").run(user.id, token, expiresAt);

    const base = process.env.BASE_URL || "http://localhost:3000";
    const link = `${base}/reset-password/${token}`;
    try {
      await sendSystemEmail({
        to: user.email,
        subject: "Manatee Password Reset",
        html: `<p>Click to reset your password:</p><p><a href=\"${link}\">Reset Password</a></p>`,
        text: `Reset your password here: ${link}`,
        eventType: "password_reset_requested",
        actorUserId: user.id,
      });
    } catch (err) {
      console.error("Failed to send reset email", err);
    }
  }

  setFlash(req, "success", "If that account exists, a password reset link has been sent.");
  return res.redirect("/login");
});

router.get("/reset-password/:token", (req, res) => {
  const token = String(req.params.token || "");
  const reset = db
    .prepare(
      `SELECT pr.id FROM password_resets pr
       WHERE pr.token = ? AND pr.used = 0 AND datetime(pr.expires_at) > datetime('now')`
    )
    .get(token);

  if (!reset) {
    return res.status(400).render("error", {
      title: "Invalid Token",
      message: "This reset link is invalid or expired.",
    });
  }

  return res.render("auth/reset-password", { title: "Reset Password", token });
});

router.post("/reset-password/:token", (req, res) => {
  const token = String(req.params.token || "");
  const password = String(req.body.password || "");

  if (password.length < 6) {
    setFlash(req, "error", "Password must be at least 6 characters.");
    return res.redirect(`/reset-password/${token}`);
  }

  const reset = db
    .prepare(
      `SELECT pr.id, pr.user_id FROM password_resets pr
       WHERE pr.token = ? AND pr.used = 0 AND datetime(pr.expires_at) > datetime('now')`
    )
    .get(token);

  if (!reset) {
    return res.status(400).render("error", {
      title: "Invalid Token",
      message: "This reset link is invalid or expired.",
    });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(hash, reset.user_id);
  db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(reset.id);

  setFlash(req, "success", "Password has been reset. Please log in.");
  return res.redirect("/login");
});

router.get("/change-password", requireAuth, (req, res) => {
  res.redirect("/profile");
});

module.exports = router;
