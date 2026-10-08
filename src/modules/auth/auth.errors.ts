import { AppError } from '../../common/app-error.js';

export const authErrors = {
  emailTaken: () => new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists'),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'),
  invalidRefreshToken: () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Session expired; sign in again'),
  invalidResetToken: () => new AppError(400, 'INVALID_RESET_TOKEN', 'Reset link is invalid or expired'),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action'),
  userNotFound: () => new AppError(404, 'USER_NOT_FOUND', 'User not found'),
};
