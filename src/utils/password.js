const crypto = require("crypto");

function generateResetToken() {
  return crypto.randomBytes(24).toString("hex");
}

module.exports = {
  generateResetToken,
};
