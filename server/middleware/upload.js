'use strict';

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuid } = require('uuid');

const UPLOAD_ROOT = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

function makeStorage(subdirResolver) {
  return multer.diskStorage({
    destination(req, _file, cb) {
      const subdir = subdirResolver(req);
      const target = path.join(UPLOAD_ROOT, subdir);
      fs.mkdirSync(target, { recursive: true });
      cb(null, target);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname) || '';
      const safe = path
        .basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9_\-]/g, '_')
        .slice(0, 60);
      cb(null, `${uuid()}__${safe}${ext}`);
    },
  });
}

const limits = {
  fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024,
};

const documentUpload = multer({
  storage: makeStorage((req) => path.join('tenders', req.params.id || 'misc')),
  limits,
});

const qaUpload = multer({
  storage: makeStorage((req) => path.join('tenders', req.params.id || 'misc', 'qa')),
  limits,
});

module.exports = {
  UPLOAD_ROOT,
  documentUpload,
  qaUpload,
};
