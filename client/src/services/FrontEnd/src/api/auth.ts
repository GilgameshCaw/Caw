// Simple token generation for development
// In production, this should request a JWT from the backend
export function generateToken(payload: { userId: number; username: string }): string {
  // For development, create a simple base64 encoded token
  // The backend should validate this properly
  return btoa(JSON.stringify({
    ...payload,
    exp: Date.now() + 24 * 60 * 60 * 1000 // 24 hours from now
  }))
}

export function decodeToken(token: string): any {
  try {
    return JSON.parse(atob(token))
  } catch {
    return null
  }
}