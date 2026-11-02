export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 72
export const PASSWORD_POLICY_HINT =
  'At least 8 characters with at least one letter and one number'

export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`
  }
  if (!/[A-Za-z]/.test(password)) return 'Include at least one letter.'
  if (!/\d/.test(password)) return 'Include at least one number.'
  return null
}

export function passwordConfirmationError(password: string, confirmation: string): string | null {
  if (!confirmation) return 'Confirm the new password.'
  if (password !== confirmation) return 'The passwords do not match.'
  return null
}
