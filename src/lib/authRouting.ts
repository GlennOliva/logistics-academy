export function signedInDestination(isAdmin: boolean) {
  return isAdmin ? '/admin' : '/dashboard'
}
