// Ошибка, текст которой можно безопасно показать пользователю.
export class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message, code = 'NOT_FOUND') => new AppError(message, { status: 404, code });
export const forbidden = (message) => new AppError(message, { status: 403, code: 'FORBIDDEN' });
export const conflict = (message, code = 'CONFLICT') => new AppError(message, { status: 409, code });
