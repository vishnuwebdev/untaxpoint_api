class AppError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthorized = (code = 'unauthorized', message = 'Authentication required') => new AppError(401, code, message);
const forbidden = (code = 'forbidden', message = 'You do not have permission for this action') => new AppError(403, code, message);
const notFound = (what = 'resource') => new AppError(404, `${what}_not_found`, `${what.replace(/_/g, ' ')} not found`);
const conflict = (code, message, details) => new AppError(409, code, message, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
