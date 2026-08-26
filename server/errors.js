'use strict';

class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

const badRequest = (msg, detail) => new HttpError(400, msg, detail);
const notFound = (msg) => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

module.exports = { HttpError, badRequest, notFound, conflict };
