const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Configure upload directory
const uploadDir = path.join(__dirname, "..", "public", "uploads", "goal-entries");

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// File filter - only allow PDF, JPG, DOC, DOCX
const fileFilter = (req, file, cb) => {
  const allowedMimes = ["application/pdf", "image/jpeg", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  const allowedExtensions = [".pdf", ".jpg", ".jpeg", ".doc", ".docx"];

  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only PDF, JPG, DOC, and DOCX files are allowed"), false);
  }
};

// Configure multer
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      // Use timestamp + random number to avoid collisions
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    },
  }),
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

// Helper function to delete uploaded file
function deleteUploadedFile(filePath) {
  if (filePath) {
    const fullPath = path.join(__dirname, "..", "public", filePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }
}

// Helper to get file path for storage in database
function getStoragePath(filename) {
  return `/uploads/goal-entries/${filename}`;
}

module.exports = {
  upload,
  deleteUploadedFile,
  getStoragePath,
  uploadDir,
};
