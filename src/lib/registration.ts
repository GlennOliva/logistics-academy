type SignupError = {
  code?: string
  status?: number
}

export function registrationErrorMessage(error: SignupError) {
  switch (error.code) {
    case 'over_email_send_rate_limit':
      return 'Verification email sending is temporarily rate-limited. This signup attempt did not create an account. Please try again later.'
    case 'weak_password':
      return 'Use at least 8 characters with at least one letter and one number.'
    case 'email_address_invalid':
      return 'Enter a valid email address that can receive a verification message.'
    case 'signup_disabled':
      return 'New student registration is temporarily disabled.'
    case 'user_already_exists':
      return 'An account already uses this email. Sign in or use password recovery.'
    default:
      return error.status === 429
        ? 'Registration is temporarily rate-limited. No account was created by this attempt. Please try again later.'
        : 'Registration was not completed. If you may already have an account, sign in or use password recovery.'
  }
}

export function registrationSuccessMessage(identityCount: number | undefined) {
  return identityCount === 0
    ? 'If this email is eligible for registration, verification instructions have been sent. Existing accounts should sign in or use password recovery.'
    : 'Account created. Check your email and open the verification link before signing in.'
}
