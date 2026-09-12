const MIN_SECRET_LENGTH = 32;

const configuredJwtSecret = process.env.JWT_SECRET;

if (
  !configuredJwtSecret ||
  configuredJwtSecret === 'dev-secret-change-me' ||
  configuredJwtSecret.length < MIN_SECRET_LENGTH
) {
  throw new Error(
    `JWT_SECRET must be set to a random value of at least ${MIN_SECRET_LENGTH} characters`
  );
}

export const JWT_SECRET = configuredJwtSecret;
