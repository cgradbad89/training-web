export const TRAINING_WEB_OWNER_EMAIL = "folstromjohn@gmail.com";

export const UNAUTHORIZED_TRAINING_USER_MESSAGE =
  "This account is not authorized to use Training Web.";

/**
 * Training Web is a single-owner private application. Firebase authentication
 * proves identity; this helper applies the separate application-authorization
 * rule shared by browser and server boundaries.
 */
export function isAuthorizedTrainingUser(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined
): boolean {
  return (
    emailVerified === true &&
    email?.trim().toLowerCase() === TRAINING_WEB_OWNER_EMAIL
  );
}
