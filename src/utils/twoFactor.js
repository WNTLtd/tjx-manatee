const speakeasy = require("speakeasy");
const QRCode = require("qrcode");

const ISSUER = "Manatee";

function normalizeToken(token) {
  return String(token || "").replace(/\s+/g, "").trim();
}

function generateTwoFactorSecret() {
  return speakeasy.generateSecret({ length: 20 }).base32;
}

function buildTwoFactorOtpAuthUrl(email, secret) {
  return speakeasy.otpauthURL({
    secret: String(secret || ""),
    label: String(email || ""),
    issuer: ISSUER,
    encoding: "base32",
  });
}

async function buildTwoFactorQrDataUrl(email, secret) {
  const otpAuthUrl = buildTwoFactorOtpAuthUrl(email, secret);
  return QRCode.toDataURL(otpAuthUrl, {
    margin: 1,
    width: 220,
  });
}

function verifyTwoFactorToken(secret, token) {
  return speakeasy.totp.verify({
    secret: String(secret || ""),
    encoding: "base32",
    token: normalizeToken(token),
    window: 1,
  });
}

module.exports = {
  generateTwoFactorSecret,
  buildTwoFactorOtpAuthUrl,
  buildTwoFactorQrDataUrl,
  verifyTwoFactorToken,
};
