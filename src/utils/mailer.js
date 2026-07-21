const nodemailer = require("nodemailer");
const { db } = require("../db");

function getSmtpSettings() {
  return db.prepare("SELECT * FROM smtp_settings WHERE id = 1").get();
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    return parsed.origin.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function getAppBaseUrl() {
  const settings = getSmtpSettings() || {};
  const fromSettings = normalizeBaseUrl(settings.base_url);
  if (fromSettings) return fromSettings;

  const fromEnv = normalizeBaseUrl(process.env.BASE_URL);
  if (fromEnv) return fromEnv;

  return "http://localhost:3000";
}

function getConfiguredFromEmail(settings) {
  const from = String(settings?.from_email || "").trim();
  if (!from) {
    throw new Error("From Email must be configured in Admin Settings.");
  }
  return from;
}

function createTransport() {
  const settings = getSmtpSettings();
  if (!settings || !settings.host || !settings.port) {
    return {
      transport: nodemailer.createTransport({ jsonTransport: true }),
      settings,
      configured: false,
    };
  }

  const transport = nodemailer.createTransport({
    host: settings.host,
    port: Number(settings.port),
    secure: Boolean(settings.secure),
    auth:
      settings.user && settings.pass
        ? {
            user: settings.user,
            pass: settings.pass,
          }
        : undefined,
  });

  return { transport, settings, configured: true };
}

async function verifySmtpSettings() {
  const { transport, configured } = createTransport();
  if (!configured) {
    return {
      ok: false,
      message: "SMTP host and port must be configured first.",
    };
  }

  await transport.verify();
  return {
    ok: true,
    message: "SMTP connection verified.",
  };
}

async function testSmtpDelivery({ to }) {
  const { transport, settings, configured } = createTransport();
  if (!configured) {
    return {
      ok: false,
      message: "SMTP host and port must be configured first.",
    };
  }

  await transport.verify();
  const from = getConfiguredFromEmail(settings);

  const testSubject = `Manatee SMTP Test ${new Date().toISOString()}`;
  const info = await transport.sendMail({
    from,
    to,
    bcc: settings?.bcc_email || undefined,
    subject: testSubject,
    text: "This is a robust SMTP test email from Manatee.",
    html: "<p>This is a robust SMTP test email from Manatee.</p>",
  });

  const accepted = Array.isArray(info.accepted) ? info.accepted : [];
  const rejected = Array.isArray(info.rejected) ? info.rejected : [];
  const pending = Array.isArray(info.pending) ? info.pending : [];
  const acceptedOk = accepted.length > 0 && rejected.length === 0;

  if (!acceptedOk) {
    return {
      ok: false,
      message: `Server did not fully accept recipient. accepted=${accepted.join(";") || "none"}, rejected=${rejected.join(";") || "none"}, pending=${pending.join(";") || "none"}`,
      details: {
        accepted,
        rejected,
        pending,
        response: info.response || "",
        messageId: info.messageId || "",
      },
    };
  }

  return {
    ok: true,
    message: "SMTP delivery test accepted by server.",
    details: {
      accepted,
      rejected,
      pending,
      response: info.response || "",
      messageId: info.messageId || "",
    },
  };
}

async function sendSystemEmail({ to, subject, html, text, bccOverride, eventType = null, actorUserId = null }) {
  const { transport, settings, configured } = createTransport();
  const from = getConfiguredFromEmail(settings);
  const bcc = bccOverride || settings?.bcc_email || undefined;

  try {
    const info = await transport.sendMail({
      from,
      to,
      bcc,
      subject,
      html,
      text,
    });

    if (!configured) {
      console.log("Email not delivered via SMTP (fallback transport used):", info.message);

      db.prepare(
        `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, actor_user_id)
         VALUES (?, 'sent', ?, ?, ?)`
      ).run(eventType, to || null, subject || null, actorUserId);

      return info;
    }

    const accepted = Array.isArray(info.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info.rejected) ? info.rejected : [];
    const pending = Array.isArray(info.pending) ? info.pending : [];
    const acceptedOk = accepted.length > 0 && rejected.length === 0;

    if (!acceptedOk) {
      const reason = `SMTP did not fully accept delivery. accepted=${accepted.join(";") || "none"}, rejected=${rejected.join(";") || "none"}, pending=${pending.join(";") || "none"}, response=${String(info.response || "")}`;
      db.prepare(
        `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, error_message, actor_user_id)
         VALUES (?, 'failed', ?, ?, ?, ?)`
      ).run(eventType, to || null, subject || null, reason, actorUserId);
      throw new Error(reason);
    }

    db.prepare(
      `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, actor_user_id)
       VALUES (?, 'sent', ?, ?, ?)`
    ).run(eventType, to || null, subject || null, actorUserId);

    return info;
  } catch (err) {
    db.prepare(
      `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, error_message, actor_user_id)
       VALUES (?, 'failed', ?, ?, ?, ?)`
    ).run(eventType, to || null, subject || null, String(err?.message || err), actorUserId);
    throw err;
  }
}

module.exports = {
  sendSystemEmail,
  getAppBaseUrl,
  getSmtpSettings,
  verifySmtpSettings,
  testSmtpDelivery,
};
